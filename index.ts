// index.ts — Deno Deploy Edge Function
// Notifies nearby providers using Firestore REST API + OneSignal
// Fixed version with service account authentication (2025/2026)

/* =======================
   ENVIRONMENT VARIABLES
======================= */
const FIRESTORE_PROJECT_ID = Deno.env.get("FIRESTORE_PROJECT_ID")!;
const ONESIGNAL_APP_ID     = Deno.env.get("ONESIGNAL_APP_ID")!;
const ONESIGNAL_REST_KEY   = Deno.env.get("ONESIGNAL_REST_KEY")!;
const GOOGLE_SERVICE_ACCOUNT_JSON = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON")!;

/* =======================
   LOGGER
======================= */
function log(level: "INFO" | "WARN" | "ERROR", message: string, data?: unknown) {
  console.log(JSON.stringify({
    level,
    message,
    data: data ?? null,
    timestamp: new Date().toISOString(),
  }));
}

/* =======================
   SERVICE ACCOUNT AUTH (JWT + OAuth2 token)
======================= */
interface TokenCache { token: string; expiresAt: number }

let cachedToken: TokenCache | null = null;

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  if (cachedToken && cachedToken.expiresAt > now + 300) { // refresh 5 min early
    return cachedToken.token;
  }

  const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const base64url = (str: string) =>
    btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const input = `${encodedHeader}.${encodedPayload}`;

  // Prepare private key (PKCS#8 PEM → binary)
  const pem = credentials.private_key
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");

  const binary = Uint8Array.from(atob(pem), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    binary,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input)
  );

  const encodedSig = base64url(String.fromCharCode(...new Uint8Array(signature)));

  const assertion = `${input}.${encodedSig}`;

  // Exchange JWT for access token
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    log("ERROR", "Failed to get access token", { status: res.status, body: errText });
    throw new Error("Token request failed");
  }

  const { access_token, expires_in } = await res.json();

  cachedToken = {
    token: access_token,
    expiresAt: now + expires_in,
  };

  log("INFO", "New access token acquired", { expires_in });
  return access_token;
}

/* =======================
   GEOHASH (accurate enough for roadside ~10-30 km)
======================= */
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

function encodeGeohash(lat: number, lon: number, precision = 7): string {
  let hash = "";
  let evenBit = true;
  let latInterval: [number, number] = [-90, 90];
  let lonInterval: [number, number] = [-180, 180];
  let bit = 0;
  let ch = 0;

  while (hash.length < precision) {
    let mid: number;
    if (evenBit) {
      mid = (lonInterval[0] + lonInterval[1]) / 2;
      if (lon > mid) {
        ch |= (1 << (4 - bit));
        lonInterval[0] = mid;
      } else {
        lonInterval[1] = mid;
      }
    } else {
      mid = (latInterval[0] + latInterval[1]) / 2;
      if (lat > mid) {
        ch |= (1 << (4 - bit));
        latInterval[0] = mid;
      } else {
        latInterval[1] = mid;
      }
    }

    evenBit = !evenBit;
    if (++bit === 5) {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

// Returns center hash + 8 neighbors (9 total)
function getGeohashNeighbors(center: string): string[] {
  // For precision 7, cell size ~150m x ~150m
  // Offsets in degrees are approximate but good enough for ~20-30 km coverage
  const approxCellDeg = 0.004; // ~450m at equator – safe buffer

  const { lat: centerLat, lon: centerLon } = approximateDecode(center);

  const offsets = [
    [ 0,  0], // self
    [ 0,  1], [ 1,  1], [ 1,  0], [ 1, -1],
    [ 0, -1], [-1, -1], [-1,  0], [-1,  1],
  ];

  return offsets.map(([dLat, dLon]) =>
    encodeGeohash(centerLat + dLat * approxCellDeg, centerLon + dLon * approxCellDeg, center.length)
  );
}

// Rough decode – just for neighbor offset calculation
function approximateDecode(hash: string): { lat: number; lon: number } {
  let lat = 0, lon = 0;
  let latMin = -90, latMax = 90;
  let lonMin = -180, lonMax = 180;
  let even = true;

  for (const char of hash) {
    const idx = BASE32.indexOf(char);
    for (let i = 4; i >= 0; i--) {
      const bit = (idx >> i) & 1;
      if (even) {
        const mid = (lonMin + lonMax) / 2;
        if (bit) lonMin = mid; else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit) latMin = mid; else latMax = mid;
      }
      even = !even;
    }
  }

  return {
    lat: (latMin + latMax) / 2,
    lon: (lonMin + lonMax) / 2,
  };
}

/* =======================
   FIRESTORE QUERY
======================= */
async function queryProviders(geohashes: string[], service: string): Promise<any[]> {
  const accessToken = await getAccessToken();

  const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents:runQuery`;

  const body = {
    structuredQuery: {
      from: [{ collectionId: "providers" }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: "geohash" },
                op: "IN",
                value: { arrayValue: { values: geohashes.map(h => ({ stringValue: h })) } },
              },
            },

            {
              fieldFilter: {
                field: { fieldPath: "servicesOffered" },
                op: "ARRAY_CONTAINS",
                value: { stringValue: service },
              },
            },
          ],
        },
      },
      limit: 50, // safety limit – adjust as needed
    },
  };

  log("INFO", "Querying providers", { geohashesCount: geohashes.length, service });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    log("ERROR", "Firestore query failed", { status: res.status, body: err });
    return [];
  }

  const json = await res.json();
  const docs = json
    .filter((r: any) => r.document)
    .map((r: any) => r.document.fields);

  log("INFO", "Providers found", { count: docs.length });
  return docs;
}

/* =======================
   ONESIGNAL PUSH
======================= */
async function sendPush(playerIds: string[], title: string, body: string, data: object) {
  if (playerIds.length === 0) return;

  const res = await fetch("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${ONESIGNAL_REST_KEY}`,
    },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      include_player_ids: playerIds,
      headings: { en: title },
      contents: { en: body },
      data,
      ios_badgeType: "SetTo",
      ios_badgeCount: 1,
    }),
  });

  if (!res.ok) {
    log("ERROR", "OneSignal push failed", await res.text());
  } else {
    log("INFO", "Push sent successfully", { count: playerIds.length });
  }
}

/* =======================
   MAIN HANDLER
======================= */
export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const payload = await req.json();
      log("INFO", "Incoming request", payload);

      const {
        requestId,
        service,
        userLocation,
        locationDescription = "",
        userName = "A user",
        geohash: clientGeohash,
      } = payload;

      if (!service || !userLocation?.latitude || !userLocation?.longitude) {
        return Response.json({ error: "Missing required fields" }, { status: 400 });
      }

      // Prefer client-provided geohash (more precise)
      const centerHash = clientGeohash || encodeGeohash(
        userLocation.latitude,
        userLocation.longitude,
        7
      );

      const geohashes = getGeohashNeighbors(centerHash);

      const providers = await queryProviders(geohashes, service);

      const playerIds = providers
        .map((p: any) => p.oneSignalSubscriptionId?.stringValue)
        .filter((id?: string) => id?.trim());

      const uniqueIds = [...new Set(playerIds as string[])];

      if (uniqueIds.length === 0) {
        log("WARN", "No matching providers found");
        return Response.json({ status: "no_providers", notified: 0 });
      }

      await sendPush(
        uniqueIds,
        `New ${service} Request Nearby`,
        `${userName} needs help${locationDescription ? ` – ${locationDescription}` : ""}`,
        { type: "new_request", requestId, service }
      );

      return Response.json({
        status: "success",
        notified: uniqueIds.length,
        message: `Notified ${uniqueIds.length} nearby provider${uniqueIds.length === 1 ? "" : "s"}`
      });

    } catch (err: any) {
      log("ERROR", "Edge function error", { message: err.message, stack: err.stack });
      return Response.json(
        { error: "Internal server error", details: err.message },
        { status: 500 }
      );
    }
  },
};