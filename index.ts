// index.ts — Deno Deploy Edge Function
// Notifies nearby providers using Firestore REST API + OneSignal
// Updated: force-include center geohash + removed acceptingRequests filter

/* =======================
   ENVIRONMENT VARIABLES
======================= */
const FIRESTORE_PROJECT_ID = Deno.env.get("FIRESTORE_PROJECT_ID")!;
const ONESIGNAL_APP_ID     = Deno.env.get("ONESIGNAL_APP_ID")!;
const ONESIGNAL_REST_KEY   = Deno.env.get("ONESIGNAL_REST_KEY")!;
const GOOGLE_SERVICE_ACCOUNT_JSON = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON")!;
console.log("BOOT CHECK", {
  FIRESTORE_PROJECT_ID: !!Deno.env.get("FIRESTORE_PROJECT_ID"),
  ONESIGNAL_APP_ID: !!Deno.env.get("ONESIGNAL_APP_ID"),
  GOOGLE_SERVICE_ACCOUNT_JSON: !!Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON"),
});


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

  if (cachedToken && cachedToken.expiresAt > now + 300) {
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
   GEOHASH
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

// Improved neighbor function + force include center
function getGeohashNeighbors(center: string): string[] {
  if (!center || center.length < 5) return [center];

  const neighbors = new Set([center]); // force include center

  // Approximate neighbors with slightly larger step for better coverage
  const step = 0.005; // ~550m at equator, adjusted for latitude ~15°
  
  const { lat: centerLat, lon: centerLon } = approximateCenter(center);

  const offsets = [
    [ 0,  0], // already included
    [ 0,  step], [ step,  step], [ step,  0], [ step, -step],
    [ 0, -step], [-step, -step], [-step,  0], [-step,  step],
    // Extra ring for safety (optional - comment out if too many)
    // [0, step*2], [step*2, 0], etc.
  ];

  for (const [dLat, dLon] of offsets) {
    const nLat = centerLat + dLat;
    const nLon = centerLon + dLon;
    const hash = encodeGeohash(nLat, nLon, center.length);
    if (hash) neighbors.add(hash);
  }

  const list = Array.from(neighbors);
  log("INFO", "Generated geohash neighbors", { 
    center, 
    count: list.length, 
    hashes: list 
  });

  return list;
}

// Better approximate center (average of bounds)
function approximateCenter(hash: string): { lat: number; lon: number } {
  let latMin = -90, latMax = 90;
  let lonMin = -180, lonMax = 180;
  let isLon = true;

  for (const c of hash) {
    const val = BASE32.indexOf(c);
    for (let i = 4; i >= 0; i--) {
      const bit = (val >> i) & 1;
      if (isLon) {
        const mid = (lonMin + lonMax) / 2;
        if (bit) lonMin = mid; else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit) latMin = mid; else latMax = mid;
      }
      isLon = !isLon;
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

  // Firestore IN filter limit protection
  const safeGeohashes = geohashes.slice(0, 10);

  const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents:runQuery`;

  log("INFO", "Firestore runQuery URL", { url });

  const body = {
    structuredQuery: {
      from: [{ collectionId: "providers" }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: "availability" },
                op: "EQUAL",
                value: { booleanValue: true }
              }
            },
            {
              fieldFilter: {
                field: { fieldPath: "servicesOffered" },
                op: "ARRAY_CONTAINS",
                value: { stringValue: service }
              }
            },
            {
              fieldFilter: {
                field: { fieldPath: "geohash" },
                op: "IN",
                value: {
                  arrayValue: {
                    values: safeGeohashes.map(h => ({ stringValue: h }))
                  }
                }
              }
            }
          ]
        }
      },
      limit: 20
    }
  };

  log("INFO", "Querying providers with filters", {
    service,
    geohashes: safeGeohashes
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    log("ERROR", "Firestore query failed", {
      status: res.status,
      body: text
    });
    return [];
  }

  log("INFO", "Firestore raw response", text);

  const json = JSON.parse(text);

  const docs = json
    .filter((r: any) => r.document)
    .map((r: any) => r.document.fields);

  log("INFO", "Providers found after filtering", {
    count: docs.length
  });

  return docs;
}

/* =======================
   ONESIGNAL PUSH
======================= */
async function sendPush(subscriptionIds: string[], title: string, body: string, data: object) {
  if (subscriptionIds.length === 0) return;

  const res = await fetch("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${ONESIGNAL_REST_KEY}`,
    },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      include_subscription_ids: subscriptionIds,
      headings: { en: title },
      contents: { en: body },
      data,
    }),
  });

  if (!res.ok) {
    log("ERROR", "OneSignal push failed", await res.text());
  } else {
    log("INFO", "Push sent successfully", { count: subscriptionIds.length });
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
	  log("INFO", "Using Firestore project", {FIRESTORE_PROJECT_ID});


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

      const centerHash = clientGeohash || encodeGeohash(
        userLocation.latitude,
        userLocation.longitude,
        7
      );

      const geohashes = getGeohashNeighbors(centerHash);

      const providers = await queryProviders(geohashes, service);

    const subscriptionIds = providers
  .map((p: any) => p.oneSignalSubscriptionId?.stringValue)
  .filter((id?: string) => typeof id === "string" && id.length > 10);

const uniqueIds = [...new Set(subscriptionIds)];

log("INFO", "Collected OneSignal subscription IDs", {
  providers: providers.length,
  subscriptions: uniqueIds.length
});


      if (uniqueIds.length === 0) {
        log("WARN", "No matching providers found", { 
          centerHash,
          geohashesCount: geohashes.length 
        });
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