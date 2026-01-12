// index.ts - Deno Deploy edge function for sending nearby roadside requests

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// ── Import Firebase Admin SDK (Deno-compatible version) ──
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js";

// IMPORTANT: For Admin auth we need firebase-admin, but Deno doesn't have native npm support yet.
// Use this community Deno port or bundle firebase-admin manually.
// For simplicity, we'll use a working Deno Firebase Admin setup via esm.sh

// Better: Use https://esm.sh/firebase-admin (works in Deno Deploy)
import admin from "https://esm.sh/firebase-admin@12.1.1?target=deno";

// ── SECRETS (set in Deno Deploy → Environment Variables) ──
const ONESIGNAL_APP_ID = Deno.env.get("ONESIGNAL_APP_ID")!;
const ONESIGNAL_REST_KEY = Deno.env.get("ONESIGNAL_REST_KEY")!;
const FIRESTORE_PROJECT_ID = Deno.env.get("FIRESTORE_PROJECT_ID")!;
const FIRESTORE_PRIVATE_KEY = Deno.env.get("FIRESTORE_PRIVATE_KEY")!.replace(/\\n/g, "\n");
const FIRESTORE_CLIENT_EMAIL = Deno.env.get("FIRESTORE_CLIENT_EMAIL")!;

// Initialize Firebase Admin
const serviceAccount = {
  projectId: FIRESTORE_PROJECT_ID,
  clientEmail: FIRESTORE_CLIENT_EMAIL,
  privateKey: FIRESTORE_PRIVATE_KEY,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// Simple geohash neighbors function (replace with real lib if needed)
function getNeighbors(geohash: string): string[] {
  // Placeholder: center + 8 neighbors (basic 3x3 grid)
  // In production: use a proper geohash library like https://deno.land/x/geohash
  return [geohash]; // ← Expand this in real code
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    const {
      requestId,
      service,
      userLocation,           // { latitude, longitude }
      locationDescription,
      userName,
    } = body;

    if (!userLocation?.latitude || !userLocation?.longitude) {
      return new Response(JSON.stringify({ error: "Missing location" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 1. Generate geohash (you need to implement or import geohash encoder)
    // For now placeholder — install https://deno.land/x/geohash in real project
    const geohash = "fakegeohash123"; // REPLACE WITH REAL ENCODING
    const nearbyHashes = getNeighbors(geohash);

    // 2. Query nearby providers (Firestore Admin SDK)
    const providersSnap = await db.collection("providers")
      .where("geohash", "in", nearbyHashes.slice(0, 10)) // max 10 for 'in'
      .where("acceptingRequests", "==", true)
      .where("services", "array-contains", service)
      .get();

    const subscriptionIds: string[] = [];
    providersSnap.forEach((doc) => {
      const data = doc.data();
      if (data.oneSignalSubscriptionId) {
        subscriptionIds.push(data.oneSignalSubscriptionId);
      }
    });

    if (subscriptionIds.length === 0) {
      return new Response(JSON.stringify({ status: "no_providers" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // 3. Send OneSignal notification
    const onesignalRes = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${ONESIGNAL_REST_KEY}`,
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        include_player_ids: subscriptionIds,
        headings: { en: `New ${service} Request Nearby` },
        contents: { en: `${userName || "A user"} needs help: ${locationDescription || "See details"}` },
        data: {
          type: "new_request",
          requestId,
          service,
        },
        ios_badgeType: "Increase",
        ios_badgeCount: 1,
      }),
    });

    if (!onesignalRes.ok) {
      const errText = await onesignalRes.text();
      console.error("OneSignal error:", errText);
      return new Response(JSON.stringify({ error: "Push failed" }), { status: 500 });
    }

    return new Response(JSON.stringify({
      status: "sent",
      count: subscriptionIds.length,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 });
  }
});