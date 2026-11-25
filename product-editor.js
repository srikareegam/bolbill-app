// Edit a product's four prices: MRP, purchase, selling and lowest (non-negotiable).
// Shared by the Bill page (✎ next to the price hint) and the Purchase page's Prices tab.
//
// mountProductEditor({ shopCode, toast, onOpenPurchase }) -> { open(name, entry, { history }) }
//   name   — the product name (for a new product it can be edited in the sheet)
//   entry  — the product from buildCatalog(), or null for a product with no prices yet
//   history: true shows the invoice price history; tapping a line calls onOpenPurchase(purchaseId)

import { saveProductPrices, deleteProduct } from "./data.js";

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const rupee = (n) => "₹" + r2(n).toFixed(2).replace(/\.00$/, "");
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtDate = (key) => key ? new Date(key + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "";

export function mountProductEditor({ shopCode, toast, onOpenPurchase }){
  const root = document.createElement("div");
  root.className = "modal-backdrop hidden";
  root.innerHTML = `
    <div class="modal">
      <div class="modal-title pe-title">Product prices</div>
      <div class="modal-sub">Used on the bill: selling price fills in, minimum warns you</div>
      <div class="field pe-name-field"><label>Product name</label><input type="text" class="pe-name" placeholder="e.g. Red Label 500g"></div>
      <div class="pe-grid">
        <div class="field"><label>MRP ₹</label><input type="number" class="pe-mrp" inputmode="decimal" placeholder="—"></div>
        <div class="field"><label>Purchase price ₹</label><input type="number" class="pe-buy" inputmode="decimal" placeholder="—"></div>
        <div class="field"><label>Selling price ₹</label><input type="number" class="pe-sell" inputmode="decimal" placeholder="—"></div>
        <div class="field"><label>Lowest (non-negotiable) ₹</label><input type="number" class="pe-min" inputmode="decimal" placeholder="—"></div>
      </div>
      <div class="pe-buy-note"></div>
      <div class="pe-msgs"></div>
      <div class="pe-history"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost pe-cancel">Cancel</button>
        <button class="btn btn-primary pe-save">Save prices</button>
      </div>
      <button class="icon-btn pe-delete" style="display:block; margin:14px auto 0; color:var(--danger);">🗑 Delete product</button>
    </div>`;
  document.body.appendChild(root);
  const q = (sel) => root.querySelector(sel);
  const num = (sel) => { const v = q(sel).value.trim(); return v === "" ? null : Number(v); };

  let current = null;       // catalog entry being edited (null = new product)
  let buyAtOpen = "";       // purchase box value when opened, to tell if it was edited by hand

  // Warnings while typing. Lowest above selling makes no sense, so that one blocks Save.
  function check(){
    const mrp = num(".pe-mrp"), buy = num(".pe-buy"), sell = num(".pe-sell"), min = num(".pe-min");
    const msgs = [];
    let block = false;
    if ([mrp, buy, sell, min].some(v => v != null && !(v >= 0))){ msgs.push(["bad", "Prices can't be negative"]); block = true; }
    if (min != null && sell != null && min > sell){ msgs.push(["bad", `Lowest price ${rupee(min)} is more than the selling price ${rupee(sell)}`]); block = true; }
    if (sell != null && mrp != null && sell > mrp) msgs.push(["warn", `Selling price ${rupee(sell)} is above MRP ${rupee(mrp)}`]);
    if (sell != null && buy != null && sell < buy) msgs.push(["warn", `Selling price ${rupee(sell)} is below what you paid (${rupee(buy)})`]);
    if (min != null && buy != null && min < buy) msgs.push(["warn", `Lowest price ${rupee(min)} is below what you paid (${rupee(buy)})`]);
    q(".pe-msgs").innerHTML = msgs.map(([kind, text]) => `<div class="pe-msg ${kind}">${escapeHtml(text)}</div>`).join("");
    q(".pe-save").disabled = block;
    return !block;
  }
  root.querySelectorAll(".pe-grid input").forEach(inp => inp.addEventListener("input", check));
  q(".pe-buy").addEventListener("input", () => {
    q(".pe-buy-note").textContent = q(".pe-buy").value.trim() !== buyAtOpen ? "Set by hand — the next invoice will update it again" : buyNote();
  });

  function buyNote(){
    const p = current && current.purchase;
    if (!p) return "";
    return p.fromInvoice ? `From invoice · ${p.supplierName || "supplier"} · ${fmtDate(p.date)}` : `Set by hand${p.date ? " · " + fmtDate(p.date) : ""}`;
  }

  function renderHistory(show){
    const box = q(".pe-history");
    const h = (current && current.history) || [];
    if (!show || !h.length){ box.innerHTML = ""; return; }
    box.innerHTML = `<div class="section-label" style="margin:14px 2px 6px;">Bought at — newest first</div>
      <div class="card" style="padding:4px 14px;">${h.map((e, i) => `
        <div class="ledger-row">
          <div class="lg-info" data-pid="${escapeHtml(e.purchaseId)}">
            <div class="lg-t1">${escapeHtml(e.supplierName || "Supplier")}${i === 0 ? ` <span style="font-size:11px; color:var(--accent-dark);">· latest</span>` : ""}</div>
            <div class="lg-t2">${fmtDate(e.date)}${onOpenPurchase ? " · tap to open the purchase" : ""}</div>
          </div>
          <div class="lg-amt">${rupee(e.price)}</div>
        </div>`).join("")}</div>`;
    if (onOpenPurchase) box.querySelectorAll("[data-pid]").forEach(el => el.onclick = () => { close(); onOpenPurchase(el.dataset.pid); });
  }

  function close(){ root.classList.add("hidden"); }
  q(".pe-cancel").onclick = close;

  q(".pe-delete").onclick = async () => {
    if (!current) return;
    const bought = (current.history || []).length;
    const note = bought
      ? (bought === 1
          ? `\n\nYour past purchase of it stays as it is. If a new invoice has it again, it comes back.`
          : `\n\nYour ${bought} past purchases of it stay as they are. If a new invoice has it again, it comes back.`)
      : "";
    if (!confirm(`Delete “${current.name}”? Its prices are removed and it leaves the Prices list and bill suggestions.${note}`)) return;
    try{
      await deleteProduct(shopCode, current.name, bought > 0);
      toast(`${current.name} deleted`);
      close();
    }catch(e){ console.error(e); toast("Couldn't delete — check your connection"); }
  };

  q(".pe-save").onclick = async () => {
    if (!check()) return;
    const name = current ? current.name : q(".pe-name").value.trim();
    if (!name){ toast("Enter the product name"); q(".pe-name").focus(); return; }
    const buyNow = q(".pe-buy").value.trim();
    const btn = q(".pe-save");
    btn.disabled = true;
    try{
      await saveProductPrices(shopCode, name, {
        mrp: num(".pe-mrp"), purchasePrice: buyNow === "" ? null : Number(buyNow),
        sellPrice: num(".pe-sell"), minPrice: num(".pe-min")
      }, buyNow !== buyAtOpen);
      toast(`Prices saved for ${name}`);
      close();
    }catch(e){ console.error(e); toast("Couldn't save — check your connection"); }
    btn.disabled = false;
  };

  return {
    open(name, entry, opts = {}){
      current = entry || null;
      q(".pe-title").textContent = current ? current.name : "New product prices";
      q(".pe-name-field").style.display = current ? "none" : "block";
      q(".pe-delete").style.display = current ? "block" : "none";
      q(".pe-name").value = current ? "" : (name || "");
      const set = (sel, v) => { q(sel).value = v == null ? "" : v; };
      set(".pe-mrp", current && current.mrp);
      set(".pe-buy", current && current.purchase && current.purchase.price);
      set(".pe-sell", current && current.sellPrice);
      set(".pe-min", current && current.minPrice);
      buyAtOpen = q(".pe-buy").value.trim();
      q(".pe-buy-note").textContent = buyNote();
      renderHistory(!!opts.history);
      check();
      root.classList.remove("hidden");
      setTimeout(() => (current ? q(".pe-sell") : q(".pe-name")).focus(), 50);
    }
  };
}
