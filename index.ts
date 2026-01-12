// index.ts — Deno Deploy Edge Function
// Purpose: Notify nearby providers using Firestore REST + OneSignal

/* =======================
   ENVIRONMENT VARIABLES
======================= */
const FIRESTORE_PROJECT_ID = Deno.env.get("FIRESTORE_PROJECT_ID")!;
const FIRESTORE_API_KEY = Deno.env.get("FIRESTORE_API_KEY")!;
const ONESIGNAL_APP_ID = Deno.env.get("ONESIGNAL_APP_ID")!;
const ONESIGNAL_REST_KEY = Deno.env.get("ONESIGNAL_REST_KEY")!;

/* =======================
   SIMPLE LOGGER
======================= */
function log(level: "INFO" | "WARN" | "ERROR", message: string, data?: unknown) {
  console.log(JSON.stringify({
    level,
    message,
    data,
    timestamp: new Date().toISOString(),
  }));
}

/* =======================
   GEOHASH (PURE TS)
======================= */
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

function encodeGeohash(lat: number, lon: number, precision = 6): string {
  let idx = 0, bit = 0;
  let even = true;
  let hash = "";

  let latMin = -90, latMax = 90;
  let lonMin = -180, lonMax = 180;

  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      lon >= mid ? (idx = (idx << 1) + 1, lonMin = mid) : (idx <<= 1, lonMax = mid);
    } else {
      const mid = (latMin + latMax) / 2;
      lat >= mid ? (idx = (idx << 1) + 1, latMin = mid) : (idx <<= 1, latMax = mid);
    }

    even = !even;
    if (++bit === 5) {
      hash += BASE32[idx];
      bit = 0;
      idx = 0;
    }
  }
  return hash;
}

function geohashNeighbors(hash: string): string[] {
  const step = 0.01;
  const { lat, lon } = decodeGeohash(hash);

  const offsets = [
    [0, 0], [step, 0], [-step, 0],
    [0, step], [0, -step],
    [step, step], [step, -step],
    [-step, step], [-step, -step],
  ];

  return [...new Set(offsets.map(
    ([dLat, dLon]) => encodeGeohash(lat + dLat, lon + dLon, hash.length),
  ))];
}

function decodeGeohash(hash: string) {
  let even = true;
  let latMin = -90, latMax = 90;
  let lonMin = -180, lonMax = 180;

  for (const c of hash) {
    const idx = BASE32.indexOf(c);
    for (let n = 4; n >= 0; n--) {
      const bit = (idx >> n) & 1;
      if (even) {
        const mid = (lonMin + lonMax) / 2;
        bit ? lonMin = mid : lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        bit ? latMin = mid : latMax = mid;
      }
      even = !even;
    }
  }
  return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 };
}

/* =======================
   FIRESTORE REST QUERY
======================= */
async function queryProviders(geohashes: string[], service: string) {
  log("INFO", "Querying Firestore", { geohashes, service });

  const url =
    `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}` +
    `/databases/(default)/documents:runQuery?key=${FIRESTORE_API_KEY}`;

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
                value: {
                  arrayValue: {
                    values: geohashes.map((h) => ({ stringValue: h })),
                  },
                },
              },
            },
            {
              fieldFilter: {
                field: { fieldPath: "acceptingRequests" },
                op: "EQUAL",
                value: { booleanValue: true },
              },
            },
            {
              fieldFilter: {
                field: { fieldPath: "services" },
                op: "ARRAY_CONTAINS",
                value: { stringValue: service },
              },
            },
          ],
        },
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    log("ERROR", "Firestore query failed", err);
    return [];
  }

  const json = await res.json();
  return json
    .map((r: any) => r.document?.fields)
    .filter(Boolean);
}

/* =======================
   ONESIGNAL PUSH
======================= */
async function sendPush(ids: string[], title: string, body: string, data: object) {
  log("INFO", "Sending OneSignal push", { count: ids.length });

  const res = await fetch("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${ONESIGNAL_REST_KEY}`,
    },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      include_player_ids: ids,
      headings: { en: title },
      contents: { en: body },
      data,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    log("ERROR", "OneSignal failed", err);
  }
}

/* =======================
   EDGE HANDLER
======================= */
export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const payload = await req.json();
      log("INFO", "Incoming request", payload);

      const { service, userLocation, userName, requestId } = payload;

      if (!userLocation?.latitude || !userLocation?.longitude) {
        return new Response("Invalid location", { status: 400 });
      }

      const center = encodeGeohash(
        userLocation.latitude,
        userLocation.longitude,
        6,
      );

      const hashes = geohashNeighbors(center).slice(0, 10);
      const providers = await queryProviders(hashes, service);

      const playerIds = providers
        .map((p: any) => p.oneSignalSubscriptionId?.stringValue)
        .filter(Boolean);

      if (!playerIds.length) {
        log("WARN", "No nearby providers");
        return Response.json({ status: "no_providers" });
      }

      await sendPush(
        playerIds,
        `New ${service} request nearby`,
        `${userName || "Someone"} needs help`,
        { requestId, service },
      );

      return Response.json({ status: "sent", count: playerIds.length });
    } catch (err) {
      log("ERROR", "Unhandled error", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
