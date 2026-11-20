// Unstressed ↔ Firebase.
// Provides three things the app and the moderation page look for:
//   window.UnstressedAuth   sign-in, sign-up, sign-out, delete account
//   window.UnstressedData   each user's saved data, stories, likes and AI replies
//   window.UnstressedAdmin  story review (only works for accounts listed in the "admins" collection)
// Each function returns plain data or throws an Error with a message people can read.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, OAuthProvider, signInWithPopup,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile,
  sendPasswordResetEmail, signOut, deleteUser, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, query, where, limit, getDoc, getDocs, setDoc, addDoc, updateDoc,
  deleteDoc, onSnapshot, serverTimestamp, getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyB_j5XwxB3tz7_68DoJSHhKl3UqlC215b8",
  authDomain: "halftime-79e0e.firebaseapp.com",
  projectId: "halftime-79e0e",
  storageBucket: "halftime-79e0e.firebasestorage.app",
  messagingSenderId: "185485502668",
  appId: "1:185485502668:web:8ebae1b7441b32b298ba69"
};

// Turn this on after Sign in with Apple is set up in your Apple Developer account
// and enabled in Firebase (Authentication → Sign-in method → Apple).
const APPLE_ENABLED = false;

// Unstressed AI server (Cloudflare Worker, see cloudflare/README.md). It writes both
// Reframe it reframes and Unstressed AI chat replies. Paste its address here, without a slash at the end.
// Leave it empty to run without AI: chat uses its built-in replies and Reframe it shows a guided version.
const AI_SERVER = "https://unstressed-reframe.bubble-youthimpact.workers.dev";
const REFRAME_URL = AI_SERVER && AI_SERVER.replace(/\/+$/, "") + "/reframe";
const CHAT_URL = AI_SERVER && AI_SERVER.replace(/\/+$/, "") + "/chat";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Keeps a copy on the device, so the app opens fast and works offline, then syncs.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// ─── Errors ─────────────────────────────────────────────────
const MESSAGES = {
  "auth/invalid-credential": "That email and password don't match. Check them and try again.",
  "auth/wrong-password": "That email and password don't match. Check them and try again.",
  "auth/user-not-found": "That email and password don't match. Check them and try again.",
  "auth/invalid-email": "That email address doesn't look right.",
  "auth/email-already-in-use": "An account with this email already exists. Try signing in instead.",
  "auth/weak-password": "Choose a password with at least 6 characters.",
  "auth/account-exists-with-different-credential": "This email is already linked to another sign-in method. Try the one you used before.",
  "auth/popup-closed-by-user": "The sign-in window was closed before it finished.",
  "auth/cancelled-popup-request": "The sign-in window was closed before it finished.",
  "auth/popup-blocked": "Your browser blocked the sign-in window. Allow pop-ups for this site and try again.",
  "auth/network-request-failed": "Can't reach the sign-in service. Check your connection and try again.",
  "auth/too-many-requests": "Too many attempts. Wait a minute and try again.",
  "auth/requires-recent-login": "For your security, sign out, sign back in, then delete your account.",
  "auth/unauthorized-domain": "Sign-in isn't set up for this web address yet. Add it under Authorized domains in Firebase.",
  "auth/operation-not-allowed": "This sign-in method isn't turned on yet. Enable it in Firebase under Sign-in method.",
  "permission-denied": "You don't have permission to do that.",
  "unavailable": "You're offline. Your changes will sync when you reconnect.",
  "resource-exhausted": "You've reached today's limit. Try again tomorrow.",
  "unauthenticated": "Please sign in again.",
  "not-signed-in": "Please sign in again."
};
const fail = (e, fallback) => {
  console.warn("[Unstressed]", e && e.code, e);
  const code = e && e.code && String(e.code).replace(/^firestore\//, "");
  return new Error(MESSAGES[e && e.code] || MESSAGES[code] || fallback || "Something went wrong. Please try again.");
};
const run = fn => async (...args) => {
  try { return await fn(...args); } catch (e) { throw fail(e); }
};
const me = () => {
  if (!auth.currentUser) throw { code: "not-signed-in" };
  return auth.currentUser;
};
// Firestore rejects undefined values; a JSON round trip removes them.
const clean = v => JSON.parse(JSON.stringify(v ?? null));
const ms = t => (t && typeof t.toMillis === "function" ? t.toMillis() : Date.now());

// ─── Auth ───────────────────────────────────────────────────
const PROVIDERS = { "google.com": "Google", "apple.com": "Apple", "password": "Email" };
const toUser = u => u && {
  uid: u.uid,
  name: u.displayName || "",
  email: u.email || "",
  provider: PROVIDERS[u.providerData[0]?.providerId] || "Email"
};
const saveProfile = u => setDoc(doc(db, "users", u.uid),
  { name: u.displayName || "", email: u.email || "", updatedAt: serverTimestamp() }, { merge: true })
  .catch(e => console.warn("[Unstressed] profile", e));

const appleProvider = () => {
  const p = new OAuthProvider("apple.com");
  p.addScope("email");
  p.addScope("name");
  return p;
};
const popup = async provider => {
  const { user } = await signInWithPopup(auth, provider);
  saveProfile(user);
  return toUser(user);
};

window.UnstressedAuth = {
  appleEnabled: APPLE_ENABLED,
  google: run(() => popup(new GoogleAuthProvider())),
  apple: run(() => popup(appleProvider())),
  email: run(async (email, pass) => toUser((await signInWithEmailAndPassword(auth, email, pass)).user)),
  signup: run(async (name, email, pass) => {
    const { user } = await createUserWithEmailAndPassword(auth, email, pass);
    await updateProfile(user, { displayName: name });
    saveProfile(user);
    return toUser(user);
  }),
  reset: run(email => sendPasswordResetEmail(auth, email)),
  signOut: run(() => signOut(auth)),
  // Firebase only deletes accounts that signed in recently, so check that first,
  // then erase the person's data (beforeDelete), then the account itself.
  deleteAccount: run(async (beforeDelete) => {
    const u = me();
    const last = Date.parse(u.metadata.lastSignInTime || 0);
    if (!last || Date.now() - last > 5 * 60 * 1000) throw { code: "auth/requires-recent-login" };
    if (beforeDelete) await beforeDelete();
    await deleteUser(u);
  }),
  onChange: cb => onAuthStateChanged(auth, u => cb(toUser(u)))
};

// ─── Data ───────────────────────────────────────────────────
// users/{uid}                 name, email
// users/{uid}/state/plan      today's plan: {day, items, mood, completed}
// users/{uid}/state/chat      {messages, savedPlans}
// users/{uid}/state/prefs     {liked}
// stories/{id}                title, body, sport, anon, authorUid, authorName, status, createdAt
// stories/{id}/likes/{uid}    one document per person who tapped "I felt this" ({at, uid})
// reports/{storyId}_{uid}     one report per person per story, read by moderators
const STATE_PARTS = ["plan", "chat", "prefs"];
const stateDoc = (uid, part) => doc(db, "users", uid, "state", part);

const REPORT_REASONS = ["unsafe", "bullying", "private", "spam", "other"];
const cleanStory = ({ title, body, sport, anon }, u) => ({
  title: String(title).trim().slice(0, 120),
  body: String(body).trim().slice(0, 5000),
  sport: String(sport).slice(0, 30),
  anon: !!anon,
  authorName: anon ? "" : (u.displayName || "").trim().split(/\s+/)[0].slice(0, 60)
});

const storyOut = d => {
  const x = d.data();
  return {
    id: d.id, title: x.title, body: x.body, sport: x.sport, anon: !!x.anon,
    authorName: x.authorName || "", status: x.status, createdAt: ms(x.createdAt)
  };
};

window.UnstressedData = {
  // Calls cb(part, data, {fromCache}) now and whenever that part changes on any device.
  // data is null when nothing is saved yet. Returns a stop function.
  watchState(cb) {
    const uid = me().uid;
    const stops = STATE_PARTS.map(part => onSnapshot(stateDoc(uid, part),
      snap => cb(part, snap.exists() ? snap.data() : null, { fromCache: snap.metadata.fromCache }),
      e => console.warn("[Unstressed] watch " + part, e)));
    return () => stops.forEach(s => s());
  },
  saveState: run(async (part, data) => {
    if (!STATE_PARTS.includes(part)) return;
    await setDoc(stateDoc(me().uid, part), { ...clean(data), updatedAt: serverTimestamp() });
  }),

  submitStory: run(async ({ title, body, sport, anon }) => {
    const u = me();
    const ref = await addDoc(collection(db, "stories"), {
      ...cleanStory({ title, body, sport, anon }, u),
      authorUid: u.uid,
      status: "pending",
      createdAt: serverTimestamp()
    });
    return ref.id;
  }),
  // Editing a story sends it back to review, so changes are checked before anyone sees them.
  updateStory: run(async (id, story) => {
    await updateDoc(doc(db, "stories", id), {
      ...cleanStory(story, me()), status: "pending", updatedAt: serverTimestamp()
    });
  }),
  deleteStory: run(id => deleteDoc(doc(db, "stories", id))),
  // One report per person per story. Returns "sent" or "already".
  reportStory: run(async (story, reason, details) => {
    const u = me();
    const ref = doc(db, "reports", story.id + "_" + u.uid);
    if ((await getDoc(ref).catch(() => null))?.exists()) return "already";
    await setDoc(ref, {
      storyId: String(story.id), storyTitle: String(story.title || "").slice(0, 120),
      reporterUid: u.uid, reason: REPORT_REASONS.includes(reason) ? reason : "other",
      details: String(details || "").trim().slice(0, 500), createdAt: serverTimestamp()
    });
    return "sent";
  }),
  watchMyStories(cb) {
    const q = query(collection(db, "stories"), where("authorUid", "==", me().uid));
    return onSnapshot(q, s => cb(s.docs.map(storyOut).sort((a, b) => b.createdAt - a.createdAt)),
      e => console.warn("[Unstressed] my stories", e));
  },
  watchPublished(cb) {
    const q = query(collection(db, "stories"), where("status", "==", "approved"), limit(100));
    return onSnapshot(q, s => cb(s.docs.map(storyOut).sort((a, b) => b.createdAt - a.createdAt)),
      e => console.warn("[Unstressed] stories", e));
  },
  likeCount: async id => {
    try { return (await getCountFromServer(collection(db, "stories", id, "likes"))).data().count; }
    catch (e) { return null; }
  },
  setLike: run(async (id, on) => {
    const ref = doc(db, "stories", id, "likes", me().uid);
    if (on) await setDoc(ref, { at: serverTimestamp(), uid: me().uid });
    else await deleteDoc(ref);
  }),

  // Changes the name shown in the app and on new stories.
  updateName: run(async name => {
    const u = me();
    await updateProfile(u, { displayName: String(name).trim().slice(0, 60) });
    const fresh = auth.currentUser || u;
    await saveProfile(fresh);
    return toUser(fresh);
  }),
  resetPassword: run(() => sendPasswordResetEmail(auth, me().email)),

  // Erases everything this person stored. Called just before their account is deleted.
  deleteAllData: run(async () => {
    const uid = me().uid;
    const prefs = await getDoc(stateDoc(uid, "prefs")).catch(() => null);
    const liked = (prefs && prefs.exists() && prefs.data().liked) || {};
    const mine = await getDocs(query(collection(db, "stories"), where("authorUid", "==", uid)));
    const reports = await getDocs(query(collection(db, "reports"), where("reporterUid", "==", uid))).catch(() => ({ docs: [] }));
    await Promise.all([
      ...Object.keys(liked).map(id => deleteDoc(doc(db, "stories", id, "likes", uid))),
      ...reports.docs.map(d => deleteDoc(d.ref)),
      ...mine.docs.map(d => deleteDoc(d.ref)),
      ...STATE_PARTS.map(p => deleteDoc(stateDoc(uid, p)))
    ]);
    await deleteDoc(doc(db, "users", uid));
  }),

  // "Reframe it": returns {acknowledge, reframe}, {crisis: true}, or {error} where error is
  // "unavailable" (no AI right now), "limit" (daily limit reached) or "unauthenticated".
  async reframe(text, avoid) {
    if (!REFRAME_URL) return { error: "unavailable" };
    try {
      const token = await me().getIdToken();
      const res = await fetch(REFRAME_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({ text, avoid: avoid || "" }),
        signal: AbortSignal.timeout(20000)
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) return { error: "limit" };
      if (res.status === 401) return { error: "unauthenticated" };
      if (!res.ok) return { error: "unavailable" };
      if (data.crisis) return { crisis: true };
      if (typeof data.reframe === "string" && data.reframe.trim()) return { acknowledge: data.acknowledge || "", reframe: data.reframe };
      return { error: "unavailable" };
    } catch (e) {
      console.warn("[Unstressed] reframe", e);
      return { error: "unavailable" };
    }
  },

  // Unstressed AI chat reply from the AI server: { text, status } or { crisis: true }.
  // Returns null if it isn't available
  // (or the daily limit is reached), so the app falls back to its built-in replies.
  async aiReply(history, cardType) {
    if (!CHAT_URL) return null;
    try {
      const token = await me().getIdToken();
      const res = await fetch(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({ history, cardType: cardType || "" }),
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      if (data.crisis) return { crisis: true };
      if (typeof data.text !== "string" || !data.text.trim()) return null;
      return { text: data.text.trim(), status: data.status || "ok" };
    } catch (e) {
      console.warn("[Unstressed] AI reply", e);
      return null;
    }
  }
};

// ─── Moderation (used by /moderate/) ────────────────────────
window.UnstressedAdmin = {
  isAdmin: async () => {
    try { return (await getDoc(doc(db, "admins", me().uid))).exists(); } catch (e) { return false; }
  },
  watchQueue(status, cb, onError) {
    const q = query(collection(db, "stories"), where("status", "==", status), limit(200));
    return onSnapshot(q, s => cb(s.docs.map(storyOut).sort((a, b) => b.createdAt - a.createdAt)),
      e => { console.warn("[Unstressed] queue", e); onError && onError(fail(e)); });
  },
  review: run(async (id, status) => {
    await updateDoc(doc(db, "stories", id), { status, reviewedAt: serverTimestamp(), reviewedBy: me().uid });
  }),
  remove: run(id => deleteDoc(doc(db, "stories", id))),
  // Reports: cb(list of {id, storyId, storyTitle, reason, details, createdAt, story})
  // where story is the reported story, or null if it has already been removed.
  watchReports(cb, onError) {
    let stopped = false;
    const stop = onSnapshot(query(collection(db, "reports"), limit(300)), async s => {
      const list = s.docs.map(d => { const x = d.data(); return {
        id: d.id, storyId: x.storyId, storyTitle: x.storyTitle || "", reason: x.reason,
        details: x.details || "", createdAt: ms(x.createdAt) }; });
      const ids = [...new Set(list.map(r => r.storyId))];
      const stories = {};
      await Promise.all(ids.map(async id => {
        const d = await getDoc(doc(db, "stories", id)).catch(() => null);
        stories[id] = d && d.exists() ? storyOut(d) : null;
      }));
      if (!stopped) cb(list.map(r => ({ ...r, story: stories[r.storyId] })).sort((a, b) => b.createdAt - a.createdAt));
    }, e => { console.warn("[Unstressed] reports", e); onError && onError(fail(e)); });
    return () => { stopped = true; stop(); };
  },
  // Clears every report about one story (after unpublishing it or deciding it's fine).
  clearReports: run(async storyId => {
    const s = await getDocs(query(collection(db, "reports"), where("storyId", "==", storyId)));
    await Promise.all(s.docs.map(d => deleteDoc(d.ref)));
  })
};

window.dispatchEvent(new Event("unstressed-firebase-ready"));
