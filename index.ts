// index.ts
// Deno Deploy Edge Function
// Sends nearby roadside requests using Firestore REST + OneSignal

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

/* ──────────────────────────────────────────────
   ENV VARIABLES (SET IN DENO DEPLOY)
────────────────────────────────────────────── */
const PROJECT_ID = Deno.env.get("FIRESTORE_PROJECT_ID")!;
const CLIENT_EMAIL = Deno.env.get("FIRESTORE_CLIENT_EMAIL")!;
const PRIVATE_KEY = Deno.env.get("FIRESTORE_PRIVATE_KEY")!.replace(/\\n/g, "\n");

const ONESIGNAL_APP_ID = Deno.env.get("ONESIGNAL_APP_ID")!;
const ONESIGNAL_REST_KEY = Deno.env.get("ONESIGNAL_REST_KEY")!;

const FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

/* ──────────────────────────────────────────────
   LOGGING
────────────────────────────────────────────── */
function log(level: "INFO" | "WARN" | "ERROR", msg: string, data?: unknown) {
  console.log(JSON.stringify({
    level,
    msg,
    data,
    time: new Date().toISOString(),
  }));
}

/* ──────────────────────────────────────────────
   GE0HASH (PURE TS)
────────────────────────────────────────────── */
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
      lon >= mid ? (idx = idx * 2 + 1, lonMin = mid) : (idx *= 2, lonMax = mid);
    } else {
      const mid = (latMin + latMax) / 2;
      lat >= mid ? (idx = idx * 2 + 1, latMin = mid) : (idx *= 2, latMax = mid);
    }
    even = !even;
    if (++bit === 5) {
      hash += BASE32[idx];
      bit = idx = 0;
    }
  }
  return hash;
}

function geohashNeighbors(hash: string): string[] {
  const step = 0.01; // ~1km
  const { lat, lon } = decodeGeohash(hash);

  const offsets = [
    [0, 0], [step, 0], [-step, 0],
    [0, step], [0, -step],
    [step, step], [step, -step],
    [-step, step], [-step, -step],
  ];

  return [...new Set(offsets.map(([dLat, dLon]) =>
    encodeGeohash(lat + dLat, lon + dLon, hash.length),
  ))];
}

function decodeGeohash(hash: string) {
  let even = true;
  let latMin = -90, latMax = 90;
  let lonMin = -180, lonMax = 180;

  for (const c of hash) {
    let idx = BASE32.indexOf(c);
    for (let i = 4; i >= 0; i--) {
      const bit = (idx >> i) & 1;
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

/* ──────────────────────────────────────────────
   FIRESTORE REST QUERY
────────────────────────────────────────────── */
async function queryProviders(geohashes: string[], service: string) {
  log("INFO", "Querying Firestore", { geohashes, service });

  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "providers" }],
          where: {
            compositeFilter: {
              op: "AND",
              filters: [
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
                {
                  fieldFilter: {
                    field: { fieldPath: "geohash" },
                    op: "IN",
                    value: {
                      arrayValue: {
                        values: geohashes.map((g) => ({ stringValue: g })),
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      }),
    },
  );

  const data = await res.json();
  return data
    .map((r: any) => r.document?.fields)
    .filter(Boolean);
}

/* ──────────────────────────────────────────────
   SEND ONESIGNAL
────────────────────────────────────────────── */
async function sendPush(ids: string[], title: string, message: string, data: any) {
  log("INFO", "Sending push", { count: ids.length });

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
      contents: { en: message },
      data,
    }),
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }
}

/* ──────────────────────────────────────────────
   HTTP HANDLER
────────────────────────────────────────────── */
serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    log("INFO", "Incoming request", body);

    const { service, userLocation, userName, requestId } = body;
    if (!userLocation?.latitude || !userLocation?.longitude) {
      return new Response("Missing location", { status: 400 });
    }

    const center = encodeGeohash(
      userLocation.latitude,
      userLocation.longitude,
      6,
    );

    const hashes = geohashNeighbors(center).slice(0, 10);
    const providers = await queryProviders(hashes, service);

    const ids = providers
      .map((p: any) => p.oneSignalSubscriptionId?.stringValue)
      .filter(Boolean);

    if (!ids.length) {
      log("WARN", "No providers found");
      return new Response(JSON.stringify({ status: "no_providers" }));
    }

    await sendPush(
      ids,
      `New ${service} request nearby`,
      `${userName || "Someone"} needs help`,
      { requestId, service },
    );

    return new Response(JSON.stringify({
      status: "sent",
      count: ids.length,
    }), { headers: { "Content-Type": "application/json" } });

  } catch (e) {
    log("ERROR", "Unhandled error", e);
    return new Response("Internal Server Error", { status: 500 });
  }
});
