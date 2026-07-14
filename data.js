// Shared data layer used by every page. Handles Shop Code + PIN, and all Firestore reads/writes.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc,
  collection, onSnapshot, query, orderBy, where, getDocs,
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

// ---------- Customer directory (for name -> phone autofill) ----------
function customerDocId(name) {
  const slug = (name || "").trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  return slug || "customer_" + Date.now();
}
export async function upsertCustomer(shopCode, name, phone) {
  name = (name || "").trim();
  phone = (phone || "").trim();
  if (!name || !phone) return;
  const ref = doc(db, "shops", shopCode, "customers", customerDocId(name));
  await setDoc(ref, { name, phone, updatedAt: serverTimestamp() }, { merge: true });
}
export function subscribeCustomers(shopCode, cb) {
  const col = collection(db, "shops", shopCode, "customers");
  return onSnapshot(col, (snap) => {
    const customers = [];
    snap.forEach(d => customers.push(d.data()));
    cb(customers);
  });
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

// ---------- Staff & attendance ----------
export function todayKey(d = new Date()) {
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}
export async function addStaff(shopCode, name) {
  const ref = doc(collection(db, "shops", shopCode, "staff"));
  await setDoc(ref, { name: name.trim(), active: true, createdAt: serverTimestamp() });
}
export function subscribeStaff(shopCode, cb) {
  const col = collection(db, "shops", shopCode, "staff");
  return onSnapshot(col, (snap) => {
    const staff = [];
    snap.forEach(d => staff.push(Object.assign({ id: d.id }, d.data())));
    staff.sort((a,b) => (a.name||"").localeCompare(b.name||""));
    cb(staff);
  });
}
export async function setStaffActive(shopCode, staffId, active) {
  await updateDoc(doc(db, "shops", shopCode, "staff", staffId), { active });
}
export async function markAttendance(shopCode, staffId, staffName, type) {
  const key = todayKey();
  const ref = doc(db, "shops", shopCode, "attendance", staffId + "_" + key);
  const payload = { staffId, staffName, dateKey: key };
  payload[type === "in" ? "inAt" : "outAt"] = serverTimestamp();
  await setDoc(ref, payload, { merge: true });
}
export function subscribeAttendanceForDate(shopCode, dateKey, cb) {
  const q = query(collection(db, "shops", shopCode, "attendance"), where("dateKey", "==", dateKey));
  return onSnapshot(q, (snap) => {
    const recs = [];
    snap.forEach(d => recs.push(d.data()));
    cb(recs);
  });
}
export async function getAttendanceRange(shopCode, startKey, endKey) {
  const q = query(collection(db, "shops", shopCode, "attendance"), where("dateKey", ">=", startKey), where("dateKey", "<=", endKey));
  const snap = await getDocs(q);
  const recs = [];
  snap.forEach(d => recs.push(d.data()));
  return recs;
}
