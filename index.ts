// index.ts — Deno Deploy Edge Function
// Sends nearby roadside requests using Firestore REST + OneSignal

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { create, getNumericDate } from "https://deno.land/x/djwt@v2.9/mod.ts";
import * as geohash from "https://deno.land/x/geohash@v1.0.2/mod.ts";

/* ───────────────────────────────
   ENVIRONMENT VARIABLES
─────────────────────────────── */
const ONESIGNAL_APP_ID = Deno.env.get("ONESIGNAL_APP_ID")!;
const ONESIGNAL_REST_KEY = Deno.env.get("ONESIGNAL_REST_KEY")!;
const FIRESTORE_PROJECT_ID = Deno.env.get("FIRESTORE_PROJECT_ID")!;
const FIRESTORE_CLIENT_EMAIL = Deno.env.get("FIRESTORE_CLIENT_EMAIL")!;
const FIRESTORE_PRIVATE_KEY = Deno.env
  .get("FIRESTORE_PRIVATE_KEY")!
  .replace(/\\n/g, "\n");

/* ───────────────────────────────
   LOGGING HELPERS
─────────────────────────────── */
function logInfo(message: string, data?: unknown) {
  console.log(
    JSON.stringify({ level: "INFO", message, data, ts: new Date().toISOString() }),
  );
}

function logError(message: string, error?: unknown) {
  console.error(
    JSON.stringify({ level: "ERROR", message, error, ts: new Date().toISOString() }),
  );
}

/* ───────────────────────────────
   FIRESTORE AUTH (JWT → OAuth)
─────────────────────────────── */
async function getFirestoreAccessToken(): Promise<string> {
  logInfo("Generating Firestore access token");

  const jwt = await create(
    { alg: "RS256", typ: "JWT" },
    {
      iss: FIRESTORE_CLIENT_EMAIL,
      scope: "https://www.googleapis.com/auth/datastore",
      aud: "https://oauth2.googleapis.com/token",
      exp: getNumericDate(60 * 60),
      iat: getNumericDate(0),
    },
    FIRESTORE_PRIVATE_KEY,
  );

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    logError("Failed to obtain Firestore token", err);
    throw new Error("Firestore auth failed");
  }

  const data = await res.json();
  return data.access_token;
}

/* ───────────────────────────────
   FIRESTORE QUERY
─────────────────────────────── */
async function queryNearbyProviders(
  geohashes: string[],
  service: string,
) {
  logInfo("Querying Firestore providers", { geohashes, service });

  const token = await getFirestoreAccessToken();

  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents:runQuery`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
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
                        values: geohashes.map((h) => ({ stringValue: h })),
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

  if (!res.ok) {
    const err = await res.text();
    logError("Firestore query failed", err);
    throw new Error("Firestore query error");
  }

  const results = await res.json();
  logInfo("Firestore query completed", { count: results.length });

  return results;
}

/* ───────────────────────────────
   ONESIGNAL PUSH
─────────────────────────────── */
async function sendOneSignalNotification(
  subscriptionIds: string[],
  payload: Record<string, unknown>,
) {
  logInfo("Sending OneSignal push", { count: subscriptionIds.length });

  const res = await fetch("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${ONESIGNAL_REST_KEY}`,
    },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      include_player_ids: subscriptionIds,
      ...payload,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    logError("OneSignal push failed", err);
    throw new Error("Push notification failed");
  }

  logInfo("OneSignal push sent successfully");
}

/* ───────────────────────────────
   HTTP HANDLER
─────────────────────────────── */
serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    logInfo("Incoming request", body);

    const {
      requestId,
      service,
      userLocation,
      locationDescription,
      userName,
    } = body;

    if (!userLocation?.latitude || !userLocation?.longitude) {
      logError("Missing user location");
      return new Response(JSON.stringify({ error: "Missing location" }), {
        status: 400,
      });
    }

    /* ── Geohash calculation ── */
    const centerHash = geohash.encode(
      userLocation.latitude,
      userLocation.longitude,
      6,
    );

    const neighbors = geohash.neighbors(centerHash);
    const hashes = [centerHash, ...neighbors].slice(0, 10);

    logInfo("Computed geohashes", hashes);

    /* ── Firestore query ── */
    const docs = await queryNearbyProviders(hashes, service);

    const subscriptionIds: string[] = [];

    for (const row of docs) {
      const doc = row.document;
      const fields = doc?.fields;
      if (fields?.oneSignalSubscriptionId?.stringValue) {
        subscriptionIds.push(fields.oneSignalSubscriptionId.stringValue);
      }
    }

    if (subscriptionIds.length === 0) {
      logInfo("No nearby providers found");
      return new Response(JSON.stringify({ status: "no_providers" }));
    }

    /* ── Push notification ── */
    await sendOneSignalNotification(subscriptionIds, {
      headings: { en: `New ${service} Request Nearby` },
      contents: {
        en: `${userName || "A user"} needs help: ${
          locationDescription || "See details"
        }`,
      },
      data: {
        type: "new_request",
        requestId,
        service,
      },
    });

    return new Response(
      JSON.stringify({ status: "sent", count: subscriptionIds.length }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    logError("Unhandled error", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
    });
  }
});
