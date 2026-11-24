// Quick calculator keypad (qty × price) shared by the Bill page and the Purchase page.
// Styles live in style.css under "Quick calculator".
//
// mountCalculator({ sub, finishLabel, toast, onAdd, onFinish }) -> { open() }
//   onAdd(item)     — called with { name, qty, price } when "+ Add item" is tapped (name may be "").
//   onFinish(item)  — called when the finish button is tapped; item is null if nothing valid is typed.
//                     Return true to close the keypad, false to keep it open.

const rupee = (n) => "₹" + (Math.round(n*100)/100).toFixed(2);

export function mountCalculator({ sub, finishLabel, toast, onAdd, onFinish }){
  const root = document.createElement("div");
  root.className = "modal-backdrop hidden";
  root.innerHTML = `
    <div class="modal">
      <div class="modal-title">Quick Calculator</div>
      <div class="modal-sub"></div>
      <div class="field"><label>Item name (optional)</label><input type="text" class="c-name" placeholder="e.g. Sugar"></div>
      <div class="calc-display">
        <div class="calc-expr">0</div>
        <div class="calc-amt">₹0.00</div>
      </div>
      <div class="calc-pad">
        <button type="button" data-k="1">1</button><button type="button" data-k="2">2</button><button type="button" data-k="3">3</button><button type="button" class="calc-op" data-k="back">⌫</button>
        <button type="button" data-k="4">4</button><button type="button" data-k="5">5</button><button type="button" data-k="6">6</button><button type="button" class="calc-op" data-k="clear">C</button>
        <button type="button" data-k="7">7</button><button type="button" data-k="8">8</button><button type="button" data-k="9">9</button><button type="button" class="calc-op calc-x" data-k="x">×</button>
        <button type="button" data-k=".">.</button><button type="button" class="calc-zero" data-k="0">0</button>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost c-close">Close</button>
        <button class="btn btn-primary c-add">+ Add item</button>
      </div>
      <button class="btn btn-print btn-full c-finish" style="margin-top:10px;"></button>
    </div>`;
  document.body.appendChild(root);
  const q = (sel) => root.querySelector(sel);
  q(".modal-sub").textContent = sub;
  q(".c-finish").textContent = finishLabel;

  let stage = "qty", qty = "", price = "";
  function render(){
    let expr = qty || "0";
    if (stage === "price") expr += " × " + (price || "0");
    q(".calc-expr").textContent = expr;
    q(".calc-amt").textContent = rupee((parseFloat(qty)||0) * (parseFloat(price)||0));
  }
  function digit(d){
    const cur = stage === "qty" ? qty : price;
    if (d === "." && cur.includes(".")) return;
    if (stage === "qty") qty += d; else price += d;
    render();
  }
  function backspace(){
    if (stage === "price"){
      if (price) price = price.slice(0,-1);
      else stage = "qty";
    } else {
      qty = qty.slice(0,-1);
    }
    render();
  }
  function reset(){ stage = "qty"; qty = ""; price = ""; q(".c-name").value = ""; render(); }
  function buildItem(){
    const nq = parseFloat(qty) || 0, np = parseFloat(price) || 0;
    if (nq <= 0 || np <= 0) return null;
    return { name: q(".c-name").value.trim(), qty: nq, price: np };
  }

  root.querySelectorAll(".calc-pad button").forEach(btn => {
    btn.onclick = () => {
      const k = btn.dataset.k;
      if (k === "back") backspace();
      else if (k === "clear") { stage = "qty"; qty = ""; price = ""; render(); }
      else if (k === "x") { if (stage === "qty" && qty){ stage = "price"; render(); } }
      else digit(k);
    };
  });
  q(".c-close").onclick = () => root.classList.add("hidden");
  q(".c-add").onclick = () => {
    const it = buildItem();
    if (!it){ toast("Enter qty and price"); return; }
    onAdd(it);
    toast((it.name || "Item") + " added");
    reset();
  };
  q(".c-finish").onclick = () => {
    if (onFinish(buildItem()) === false) return;
    root.classList.add("hidden");
    reset();
  };

  return { open(){ reset(); root.classList.remove("hidden"); } };
}
