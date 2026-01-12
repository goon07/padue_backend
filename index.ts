// index.ts - Deno Deploy edge function for sending nearby roadside requests

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"; // or use firebase-admin if you prefer

// ── SECRETS (set these in Deno Deploy dashboard → Environment Variables) ──
const ONESIGNAL_APP_ID = Deno.env.get("ONESIGNAL_APP_ID")!;
const ONESIGNAL_REST_KEY = Deno.env.get("ONESIGNAL_REST_KEY")!;
const FIRESTORE_PROJECT_ID = Deno.env.get("FIRESTORE_PROJECT_ID")!;
const FIRESTORE_PRIVATE_KEY = Deno.env.get("FIRESTORE_PRIVATE_KEY")!.replace(/\\n/g, "\n");
const FIRESTORE_CLIENT_EMAIL = Deno.env.get("FIRESTORE_CLIENT_EMAIL")!;

// Initialize Firebase Admin (Deno-compatible)
import { initializeApp, cert } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js";

const firebaseApp = initializeApp({
  credential: cert({
    projectId: FIRESTORE_PROJECT_ID,
    clientEmail: FIRESTORE_CLIENT_EMAIL,
    privateKey: FIRESTORE_PRIVATE_KEY,
  }),
});

const db = getFirestore(firebaseApp);

// Simple geohash neighbors (you can use a small lib or this basic version)
function getNeighbors(geohash: string): string[] {
  // Basic 3x3 grid neighbors (center + 8 around) - for production use geohash lib
  const base32 = "0123456789bcdefghjkmnpqrstuvwxyz";
  const directions = [
    [0, 0], [0, 1], [0, -1], [1, 0], [-1, 0],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];
  const neighbors: string[] = [geohash];

  // Very simplified - for real use, import a geohash lib like https://deno.land/x/geohash
  return neighbors; // ← Replace with real neighbor logic
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
      userLocation, // { latitude, longitude }
      locationDescription,
      userName,
    } = body;

    if (!userLocation?.latitude || !userLocation?.longitude) {
      return new Response("Missing location", { status: 400 });
    }

    // 1. Generate geohash for request (match precision used in app)
    // For simplicity - in real app use same geohash lib as Flutter (dart_geohash → JS port)
    const geohash = "fakegeohash123"; // ← REPLACE with actual geohash encoding
    const nearbyHashes = getNeighbors(geohash);

    // 2. Query nearby providers
    const providersSnap = await db.collection("providers")
      .where("geohash", "in", nearbyHashes.slice(0, 10)) // Firestore 'in' max 10
      .where("acceptingRequests", "==", true)
      .where("services", "array-contains", service)
      .get();

    const subscriptionIds: string[] = [];
    providersSnap.forEach((doc) => {
      const subId = doc.data().oneSignalSubscriptionId;
      if (subId) subscriptionIds.push(subId);
    });

    if (subscriptionIds.length === 0) {
      return new Response(JSON.stringify({ status: "no_providers" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // 3. Send OneSignal push
    const response = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${ONESIGNAL_REST_KEY}`,
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        include_player_ids: subscriptionIds,
        headings: { en: `New ${service} Request Nearby` },
        contents: { en: `${userName} needs help: ${locationDescription || "See details"}` },
        data: {
          type: "new_request",
          requestId,
          service,
        },
        ios_badgeType: "Increase",
        ios_badgeCount: 1,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("OneSignal failed:", err);
      return new Response("Push failed", { status: 500 });
    }

    return new Response(JSON.stringify({
      status: "sent",
      count: subscriptionIds.length,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response("Internal error", { status: 500 });
  }
});