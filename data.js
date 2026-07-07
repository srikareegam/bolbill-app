// Shared data layer used by every page. Handles Shop Code + PIN, and all Firestore reads/writes.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc,
  collection, onSnapshot, query, orderBy,
  serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

const LS_SHOP = "bolbill_shop";

// ---------- PIN hashing (PIN itself is never stored or sent in plain text) ----------
export async function hashPin(pin) {
  const enc = new TextEncoder().encode(String(pin));
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function genShopCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars like 0/O, 1/I
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function getSavedShop() {
  try {
    const v = localStorage.getItem(LS_SHOP);
    return v ? JSON.parse(v) : null;
  } catch (e) { return null; }
}
export function saveShopLocally(shopCode, pinHash) {
  localStorage.setItem(LS_SHOP, JSON.stringify({ shopCode, pinHash }));
}
export function clearSavedShop() {
  localStorage.removeItem(LS_SHOP);
}
export function requireShopOrRedirect() {
  const s = getSavedShop();
  if (!s) {
    window.location.href = "join.html";
    return null;
  }
  return s;
}

// ---------- Shop create / join ----------
export async function createShop(shopName, pin) {
  const shopCode = genShopCode();
  const pinHash = await hashPin(pin);
  const ref = doc(db, "shops", shopCode);
  await setDoc(ref, {
    shopName: shopName || "My Shop",
    shopAddress: "", shopPhone: "", shopGst: "",
    shopFooter: "Thank you, visit again!",
    taxRate: 0, pinHash, nextBillNo: 1
  });
  saveShopLocally(shopCode, pinHash);
  return shopCode;
}

export async function joinShop(shopCode, pin) {
  shopCode = (shopCode || "").trim().toUpperCase();
  const ref = doc(db, "shops", shopCode);
  const snap = await getDoc(ref);
  if (!snap.exists()) return { ok: false, reason: "notfound" };
  const pinHash = await hashPin(pin);
  if (snap.data().pinHash !== pinHash) return { ok: false, reason: "pin" };
  saveShopLocally(shopCode, pinHash);
  return { ok: true };
}

// ---------- Settings (shop details) — live synced across devices ----------
export function subscribeSettings(shopCode, cb) {
  const ref = doc(db, "shops", shopCode);
  return onSnapshot(ref, (snap) => { if (snap.exists()) cb(snap.data()); });
}
export async function saveSettings(shopCode, settings) {
  const ref = doc(db, "shops", shopCode);
  await updateDoc(ref, settings);
}

// ---------- Bills ----------
// Atomic: reads+increments the shared bill counter and writes the bill in one transaction,
// so two devices billing at the same moment never collide on the same bill number.
export async function createBillAtomic(shopCode, billData) {
  const shopRef = doc(db, "shops", shopCode);
  const billsCol = collection(db, "shops", shopCode, "bills");
  const newBillRef = doc(billsCol);
  let assignedBillNo;
  await runTransaction(db, async (tx) => {
    const shopSnap = await tx.get(shopRef);
    const current = shopSnap.exists() ? (shopSnap.data().nextBillNo || 1) : 1;
    assignedBillNo = current;
    tx.set(newBillRef, Object.assign({}, billData, { billNo: current, createdAt: serverTimestamp() }));
    tx.update(shopRef, { nextBillNo: current + 1 });
  });
  return assignedBillNo;
}

export function subscribeBills(shopCode, cb) {
  const billsCol = collection(db, "shops", shopCode, "bills");
  const q = query(billsCol, orderBy("billNo", "desc"));
  return onSnapshot(q, (snap) => {
    const bills = [];
    snap.forEach(d => bills.push(Object.assign({ id: d.id }, d.data())));
    cb(bills);
  });
}
