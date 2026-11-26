// Shared data layer used by every page. Handles Shop Code + PIN, and all Firestore reads/writes.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc,
  collection, onSnapshot, query, orderBy, where, getDocs,
  serverTimestamp, runTransaction, writeBatch, arrayUnion
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

export async function updateBill(shopCode, billId, updates) {
  await updateDoc(doc(db, "shops", shopCode, "bills", billId), updates);
}

// ---------- Suppliers, purchases & supplier payments ----------
// Supplier balances are never stored — pages compute them from purchases and payments,
// so editing or deleting a purchase can't leave a stale balance behind.
function subscribeCol(shopCode, name, cb, sortField) {
  const col = collection(db, "shops", shopCode, name);
  const q = sortField ? query(col, orderBy(sortField, "desc")) : col;
  return onSnapshot(q, (snap) => {
    const rows = [];
    snap.forEach(d => rows.push(Object.assign({ id: d.id }, d.data())));
    cb(rows);
  });
}
export function subscribeSuppliers(shopCode, cb) {
  return subscribeCol(shopCode, "suppliers", (rows) => {
    rows.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    cb(rows);
  });
}
export async function addSupplier(shopCode, { name, phone = "", gstin = "" }) {
  const ref = await addDoc(collection(db, "shops", shopCode, "suppliers"),
    { name: name.trim(), phone: phone.trim(), gstin: gstin.trim(), createdAt: serverTimestamp() });
  return ref.id;
}
export async function updateSupplier(shopCode, supplierId, fields) {
  await updateDoc(doc(db, "shops", shopCode, "suppliers", supplierId), fields);
}
// The Purchase page only allows this once the supplier has no purchases or payments left.
export async function deleteSupplier(shopCode, supplierId) {
  await deleteDoc(doc(db, "shops", shopCode, "suppliers", supplierId));
}

export function subscribePurchases(shopCode, cb) {
  return subscribeCol(shopCode, "purchases", cb, "invoiceDate");
}
// Invoice photos live in their own collection (same id as the purchase) so the purchase
// list stays small — a photo is only downloaded when that purchase is opened.
// Purchase + photo are written in one batch: both save, or neither does.
const photoRef = (shopCode, purchaseId) => doc(db, "shops", shopCode, "purchasePhotos", purchaseId);

export async function createPurchase(shopCode, data, photoB64) {
  const ref = doc(collection(db, "shops", shopCode, "purchases"));
  const batch = writeBatch(db);
  batch.set(ref, Object.assign({}, data, { hasPhoto: !!photoB64, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  if (photoB64) batch.set(photoRef(shopCode, ref.id), { data: photoB64, createdAt: serverTimestamp() });
  await batch.commit();
  return ref.id;
}
// photoB64: a new photo to replace the old one, null to remove the photo,
// or undefined to leave the photo as it is.
export async function updatePurchase(shopCode, purchaseId, data, photoB64) {
  const batch = writeBatch(db);
  const fields = Object.assign({}, data, { updatedAt: serverTimestamp() });
  if (photoB64) {
    fields.hasPhoto = true;
    batch.set(photoRef(shopCode, purchaseId), { data: photoB64, createdAt: serverTimestamp() });
  } else if (photoB64 === null) {
    fields.hasPhoto = false;
    batch.delete(photoRef(shopCode, purchaseId));
  }
  batch.update(doc(db, "shops", shopCode, "purchases", purchaseId), fields);
  await batch.commit();
}
export async function deletePurchase(shopCode, purchaseId) {
  const batch = writeBatch(db);
  batch.delete(doc(db, "shops", shopCode, "purchases", purchaseId));
  batch.delete(photoRef(shopCode, purchaseId));
  await batch.commit();
}
export async function getPurchasePhoto(shopCode, purchaseId) {
  const snap = await getDoc(photoRef(shopCode, purchaseId));
  return snap.exists() ? snap.data().data : null;
}

export function subscribeSupplierPayments(shopCode, cb) {
  return subscribeCol(shopCode, "supplierPayments", cb, "date");
}
export async function addSupplierPayment(shopCode, data) {
  await addDoc(collection(db, "shops", shopCode, "supplierPayments"),
    Object.assign({}, data, { createdAt: serverTimestamp() }));
}
export async function deleteSupplierPayment(shopCode, paymentId) {
  await deleteDoc(doc(db, "shops", shopCode, "supplierPayments", paymentId));
}

// Amount still owed to each supplier: sum of (total - paidNow) on purchases minus later payments.
export function computeSupplierBalances(purchases, payments) {
  const bal = {};
  purchases.forEach(p => { bal[p.supplierId] = (bal[p.supplierId] || 0) + (p.total || 0) - (p.paidNow || 0); });
  payments.forEach(p => { bal[p.supplierId] = (bal[p.supplierId] || 0) - (p.amount || 0); });
  return bal;
}

// ---------- Product prices (latest purchase price per product) ----------
// Same product, different spelling: "Red Label 500 gm" and "red label 500g" give the same key.
const UNIT_CANON = {
  g: "g", gm: "g", gms: "g", gram: "g", grams: "g", gr: "g",
  kg: "kg", kgs: "kg", kilo: "kg", kilos: "kg",
  l: "l", ltr: "l", ltrs: "l", litre: "l", litres: "l", liter: "l", liters: "l", lt: "l",
  ml: "ml", mls: "ml",
  pc: "pc", pcs: "pc", piece: "pc", pieces: "pc",
};
export function productKey(name) {
  return String(name || "").toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s.]/gu, " ")      // drop punctuation, keep letters of any script (Telugu too)
    .replace(/\s+/g, " ").trim()
    // "500 gm" / "500gms" / "1 Kilo" -> "500g" / "1kg"; only real units are joined to the number
    .replace(/(\d+(?:\.\d+)?)\s?([a-z]+)\b/g, (m, num, unit) => UNIT_CANON[unit] ? num + UNIT_CANON[unit] : m);
}

// ---------- Pack (bulk) prices ----------
// A purchase line is either loose (price per piece) or a pack — case, bag, box or carton:
// price = the whole pack, perCase = how much is in it, packType = which kind of pack,
// packUnit = what perCase counts (pcs, kg, g, ltr, ml). The individual price (₹50/kg) is worked out.
export const PACK_TYPES = ["case", "bag", "box", "carton"];
export const PACK_UNITS = ["pcs", "kg", "g", "ltr", "ml"];
export function packOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 2 ? n : null;
}
// Older lines saved before bags/boxes/cartons existed are cases.
export function packTypeOf(t) {
  return PACK_TYPES.includes(t) ? t : "case";
}
// Older lines saved before units existed count pieces.
export function packUnitOf(u) {
  return PACK_UNITS.includes(u) ? u : "pcs";
}
// "bag of 25 kg", "carton of 48" (pieces aren't spelled out), or "loose".
export function packText(perCase, packType, packUnit) {
  if (!packOrNull(perCase)) return "loose";
  const unit = packUnitOf(packUnit);
  return `${packTypeOf(packType)} of ${packOrNull(perCase)}${unit === "pcs" ? "" : " " + unit}`;
}
// " / bag of 25 kg" for a pack price, "" for a loose one.
export function unitLabel(perCase, packType, packUnit) {
  return packOrNull(perCase) ? " / " + packText(perCase, packType, packUnit) : "";
}
// The individual price inside a pack: ₹1250 bag of 25 kg -> 50 per kg; ₹400 carton of 48 -> 8.33 per pc.
// Grams and ml are given per kg / per ltr (a price per gram isn't useful).
export function unitPrice(price, perCase, packUnit) {
  const n = packOrNull(perCase);
  if (!n || !(Number(price) > 0)) return null;
  const unit = packUnitOf(packUnit);
  const qty = unit === "g" || unit === "ml" ? n / 1000 : n;
  const per = { pcs: "pc", kg: "kg", g: "kg", ltr: "ltr", ml: "ltr" }[unit];
  return { value: Math.round((Number(price) / qty) * 100) / 100, per };
}
// "₹50/kg", "₹8.33/pc", or "" for a loose price.
export function unitPriceText(price, perCase, packUnit) {
  const u = unitPrice(price, perCase, packUnit);
  return u ? `₹${u.value.toFixed(2).replace(/\.00$/, "")}/${u.per}` : "";
}
// Two prices can only be compared (▲/▼) when they're for the same pack.
export function samePack(aPerCase, bPerCase, aType, bType, aUnit, bUnit) {
  if (packOrNull(aPerCase) !== packOrNull(bPerCase)) return false;
  if (!packOrNull(aPerCase)) return true;
  return packTypeOf(aType) === packTypeOf(bType) && packUnitOf(aUnit) === packUnitOf(bUnit);
}
// A supplier's free-goods offer on a purchase line, e.g. buy 10 get 1 free -> { buy: 10, free: 1 }.
export function offerOrNull(o) {
  const buy = Number(o && o.buy), free = Number(o && o.free);
  return Number.isInteger(buy) && buy >= 1 && Number.isInteger(free) && free >= 1 ? { buy, free } : null;
}
export function offerText(o) {
  const v = offerOrNull(o);
  return v ? `buy ${v.buy} get ${v.free} free` : "";
}

// Builds Map(key -> { key, name, price, perCase, packType, packUnit, offer, date, supplierName, supplierId, purchaseId, history[] }).
// "Latest" = newest invoice date, then newest entry that day; within one invoice the last row wins.
// Worked out from purchases every time, so editing/deleting a purchase can't leave a stale price.
export function buildPriceList(purchases) {
  const ms = (p) => (p.createdAt && p.createdAt.toMillis) ? p.createdAt.toMillis() : Date.now();
  const ordered = purchases.slice().sort((a, b) =>
    (a.invoiceDate || "").localeCompare(b.invoiceDate || "") || ms(a) - ms(b));
  const list = new Map();
  const savedMs = (p) => (p.updatedAt && p.updatedAt.toMillis) ? p.updatedAt.toMillis() : ms(p);
  ordered.forEach(p => (p.items || []).forEach(it => {
    const key = productKey(it.name);
    if (!key) return;
    const perCase = packOrNull(it.perCase);
    const entry = {
      price: it.price, perCase, packType: perCase ? packTypeOf(it.packType) : null, packUnit: perCase ? packUnitOf(it.packUnit) : null,
      offer: offerOrNull(it.offer),
      date: p.invoiceDate, supplierName: p.supplierName, supplierId: p.supplierId, purchaseId: p.id, savedAt: savedMs(p)
    };
    const prev = list.get(key);
    const history = prev ? [entry, ...prev.history] : [entry];
    list.set(key, Object.assign({ key, name: it.name }, entry, { history }));
  }));
  return list;
}

// For the Bill page hint: an exact product first, otherwise products whose name has every typed word.
export function findPriceMatches(priceList, typed, limit = 3) {
  const key = productKey(typed);
  if (!key) return { exact: null, matches: [] };
  const exact = priceList.get(key) || null;
  if (exact) return { exact, matches: [] };
  const words = key.split(" ");
  const matches = [...priceList.values()]
    .filter(e => words.every(w => e.key.includes(w)))
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, limit);
  return { exact: null, matches };
}

// ---------- Products: MRP, purchase and selling price ----------
// One doc per product, id = productKey(name), so spelling variants share one set of prices.
export function subscribeProducts(shopCode, cb) {
  return subscribeCol(shopCode, "products", cb);
}
const priceOrNull = (v) => (v === "" || v == null || !(Number(v) > 0)) ? null : Math.round(Number(v) * 100) / 100;
// The pack a product is bought in: its own setting if saved, else the pack of its latest purchase price.
// effectivePack -> how many in the pack (null = loose); effectivePackType -> "case" | "bag" | "box" | "carton".
export function effectivePack(entry) {
  if (!entry) return null;
  if (entry.packSet) return entry.pack;
  return entry.purchase ? packOrNull(entry.purchase.perCase) : null;
}
export function effectivePackType(entry) {
  if (!entry || !effectivePack(entry)) return null;
  if (entry.packSet) return packTypeOf(entry.packType);
  return packTypeOf(entry.purchase && entry.purchase.packType);
}
export function effectivePackUnit(entry) {
  if (!entry || !effectivePack(entry)) return null;
  if (entry.packSet) return packUnitOf(entry.packUnit);
  return packUnitOf(entry.purchase && entry.purchase.packUnit);
}

// purchaseChanged: the purchase price was typed by hand — it then wins until the next invoice.
// prices.pack / prices.packType / prices.packUnit: how much is in the pack (null = loose), which kind of
//   pack and what it counts (pcs, kg, …);
//   also the pack a hand-typed purchase price is for.
// before: the product as it was (from buildCatalog), so the change can be written to its price history.
// via: where it was changed — "bill" or "prices".
// Every save that changes something adds one entry to `changes`:
//   { at, via, diff: { sellPrice: { from, to }, pack: { from, to }, … } }.
export async function saveProductPrices(shopCode, name, prices, purchaseChanged, { before = null, via = "" } = {}) {
  const key = productKey(name);
  if (!key) throw new Error("The product needs a name");
  const data = {
    key, name: String(name).trim(),
    mrp: priceOrNull(prices.mrp), sellPrice: priceOrNull(prices.sellPrice),
    deletedAt: null,                 // setting prices again brings a deleted product back
    updatedAt: serverTimestamp()
  };
  const newPack = packOrNull(prices.pack), newType = newPack ? packTypeOf(prices.packType) : null;
  const newUnit = newPack ? packUnitOf(prices.packUnit) : null;
  if ("pack" in prices) { data.perCase = newPack; data.packType = newType; data.packUnit = newUnit; }
  if (purchaseChanged) {
    data.purchasePrice = priceOrNull(prices.purchasePrice);
    data.purchasePerCase = newPack;
    data.purchasePackType = newType;
    data.purchasePackUnit = newUnit;
    data.purchaseSetAt = Date.now();
  }
  const old = {
    mrp: before ? before.mrp : null, sellPrice: before ? before.sellPrice : null,
    purchasePrice: before && before.purchase ? before.purchase.price : null,
    pack: effectivePack(before), packType: effectivePackType(before), packUnit: effectivePackUnit(before)
  };
  const diff = {};
  ["mrp", "purchasePrice", "sellPrice"].forEach(f => {
    if (!(f in data)) return;                          // purchase price not touched
    const from = old[f] ?? null, to = data[f] ?? null;
    if (from !== to) diff[f] = { from, to };
  });
  if ("perCase" in data && packText(old.pack, old.packType, old.packUnit) !== packText(newPack, newType, newUnit)) {
    diff.pack = { from: old.pack ?? null, fromType: old.packType ?? null, fromUnit: old.packUnit ?? null, to: newPack, toType: newType, toUnit: newUnit };
  }
  if (Object.keys(diff).length) data.changes = arrayUnion({ at: Date.now(), via, diff });
  await setDoc(doc(db, "shops", shopCode, "products", key), data, { merge: true });
}

// Rename a product. Its prices and price history move to the new name, and the product's lines on
// past purchases are renamed too, so invoice history follows. Sales bills keep the name they were
// printed with. Refuses a name that already belongs to another product.
export async function renameProduct(shopCode, oldName, newName, via = "") {
  const oldKey = productKey(oldName), newKey = productKey(newName);
  const name = String(newName || "").trim();
  if (!newKey) throw new Error("The product needs a name");
  const prodCol = collection(db, "shops", shopCode, "products");
  const purchasesSnap = await getDocs(collection(db, "shops", shopCode, "purchases"));
  if (newKey !== oldKey) {
    const clashDoc = await getDoc(doc(prodCol, newKey));
    const clashInvoice = purchasesSnap.docs.some(d => (d.data().items || []).some(it => productKey(it.name) === newKey));
    if ((clashDoc.exists() && !clashDoc.data().deletedAt) || clashInvoice) throw new Error(`A product called “${name}” already exists`);
  }
  const oldSnap = await getDoc(doc(prodCol, oldKey));
  const base = oldSnap.exists() ? oldSnap.data() : {};
  const ops = [];
  ops.push(b => b.set(doc(prodCol, newKey), Object.assign({}, base, {
    key: newKey, name, updatedAt: serverTimestamp(),
    changes: [...(Array.isArray(base.changes) ? base.changes : []), { at: Date.now(), via, renamedFrom: String(oldName).trim() }]
  })));
  if (newKey !== oldKey && oldSnap.exists()) ops.push(b => b.delete(oldSnap.ref));
  purchasesSnap.docs.forEach(d => {
    const items = d.data().items || [];
    if (!items.some(it => productKey(it.name) === oldKey)) return;
    // only the item names change — the purchase's own dates stay as they were
    ops.push(b => b.update(d.ref, { items: items.map(it => productKey(it.name) === oldKey ? Object.assign({}, it, { name }) : it) }));
  });
  for (let i = 0; i < ops.length; i += 450) {          // Firestore allows 500 writes per batch
    const batch = writeBatch(db);
    ops.slice(i, i + 450).forEach(op => op(batch));
    await batch.commit();
  }
}

// Delete a product: its prices go, and it leaves the Prices list and bill suggestions.
// Past purchases are never touched. If it was on invoices, a marker remembers the delete (and keeps
// the price history), and the product comes back by itself only when a newer invoice includes it again.
export async function deleteProduct(shopCode, name, hasInvoices, via = "") {
  const key = productKey(name);
  const ref = doc(db, "shops", shopCode, "products", key);
  if (!hasInvoices) { await deleteDoc(ref); return; }
  await setDoc(ref, {
    key, name: String(name).trim(),
    mrp: null, sellPrice: null, minPrice: null, purchasePrice: null, purchaseSetAt: null,
    deletedAt: Date.now(), updatedAt: serverTimestamp(),
    changes: arrayUnion({ at: Date.now(), via, deleted: true })
  }, { merge: true });
}

// Every product with its prices: Map(key -> { key, name, mrp, sellPrice, pack, packType, packUnit, packSet,
//   purchase: { price, perCase, packType, packUnit, offer, date, supplierName, supplierId, fromInvoice } | null,
//   prevInvoice, prevInvoicePrice, history[], changes[] }).
// Purchase price = whichever was entered last: the newest invoice line, or a price typed by hand.
export function buildCatalog(purchases, productDocs) {
  const invoices = buildPriceList(purchases);
  const docs = new Map(productDocs.map(d => [d.key || productKey(d.name), d]));
  const catalog = new Map();
  new Set([...invoices.keys(), ...docs.keys()]).forEach(key => {
    if (!key) return;
    const inv = invoices.get(key), d = docs.get(key) || {};
    if (d.deletedAt && !(inv && inv.savedAt > d.deletedAt)) return;   // deleted, and not bought again since
    const manual = priceOrNull(d.purchasePrice);
    let purchase = null;
    if (inv && (manual == null || inv.savedAt > (d.purchaseSetAt || 0))) {
      purchase = { price: inv.price, perCase: inv.perCase, packType: inv.packType, packUnit: inv.packUnit, offer: inv.offer, date: inv.date, supplierName: inv.supplierName, supplierId: inv.supplierId, fromInvoice: true };
    } else if (manual != null) {
      const per = packOrNull(d.purchasePerCase);
      purchase = { price: manual, perCase: per, packType: per ? packTypeOf(d.purchasePackType) : null, packUnit: per ? packUnitOf(d.purchasePackUnit) : null, date: d.purchaseSetAt ? todayKey(new Date(d.purchaseSetAt)) : "", fromInvoice: false };
    }
    catalog.set(key, {
      key, name: d.name || (inv && inv.name) || key,
      mrp: priceOrNull(d.mrp), sellPrice: priceOrNull(d.sellPrice),
      // product detail: how many in the pack (null = loose) and which kind of pack
      pack: packOrNull(d.perCase), packType: packOrNull(d.perCase) ? packTypeOf(d.packType) : null,
      packUnit: packOrNull(d.perCase) ? packUnitOf(d.packUnit) : null, packSet: "perCase" in d,
      purchase,
      prevInvoice: inv && inv.history[1] ? inv.history[1] : null,
      prevInvoicePrice: inv && inv.history[1] ? inv.history[1].price : null,
      history: inv ? inv.history : [],          // invoice lines, newest first
      changes: Array.isArray(d.changes) ? d.changes : []   // hand edits to the prices, oldest first
    });
  });
  return catalog;
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
export async function updateStaff(shopCode, staffId, fields) {
  await updateDoc(doc(db, "shops", shopCode, "staff", staffId), fields);
}
export async function markAttendance(shopCode, staffId, staffName, type) {
  const key = todayKey();
  const ref = doc(db, "shops", shopCode, "attendance", staffId + "_" + key);
  // sessions: [{in: millis, out: millis|null}, ...] — multiple in/outs per day.
  // (Client timestamps because Firestore doesn't allow serverTimestamp inside arrays.)
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    let sessions = [];
    if (snap.exists()) {
      const d = snap.data();
      if (Array.isArray(d.sessions)) {
        sessions = d.sessions.slice();
      } else if (d.inAt) {
        // migrate old one-session-per-day format
        const inMs = d.inAt.toMillis ? d.inAt.toMillis() : d.inAt;
        const outMs = d.outAt ? (d.outAt.toMillis ? d.outAt.toMillis() : d.outAt) : null;
        sessions = [{ in: inMs, out: outMs }];
      }
    }
    const last = sessions[sessions.length - 1];
    if (type === "in") {
      if (last && last.out === null) return; // already checked in — ignore double tap
      sessions.push({ in: Date.now(), out: null });
    } else {
      if (!last || last.out !== null) return; // not currently in — ignore
      last.out = Date.now();
    }
    tx.set(ref, { staffId, staffName, dateKey: key, sessions }, { merge: true });
  });
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
