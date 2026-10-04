/* Route Optimizer Colombo — site script
 *
 * The hero map is an illustration. Major roads are coloured by
 *   OSRM motorcycle-profile speed  x  hour factor
 * where the factor mirrors the rule in ml-pipeline/update_osrm_traffic.py:
 *   07–09 h and 16–19 h -> x0.4, 00–05 h -> x1.5, otherwise x1.0
 */
(function () {
  "use strict";

  // ---- Speed model (from profiles/motorcycle.lua) ----
  const BASE_SPEED = {
    major: 85,      // trunk (motorway is 90; both read as "fast")
    primary: 40,
    secondary: 55,
    tertiary: 40,
  };

  function hourFactor(h) {
    if ((h >= 7 && h <= 9) || (h >= 16 && h <= 19)) return 0.4;
    if (h >= 0 && h <= 5) return 1.5;
    return 1.0;
  }

  function band(kmh) {
    if (kmh >= 35) return "var(--fast)";
    if (kmh >= 20) return "var(--mid)";
    return "var(--slow)";
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function describe(h) {
    const f = hourFactor(h);
    const label = f < 1 ? "peak" : f > 1 ? "night" : "no adjustment";
    return `${pad(h)}:00 · ${label} · speeds ×${f}`;
  }

  // ---- Map ----
  const SVG_NS = "http://www.w3.org/2000/svg";
  const data = window.COLOMBO_MAP;
  const svg = document.getElementById("map-svg");
  const roadEls = {};

  function el(name, attrs, parent) {
    const n = document.createElementNS(SVG_NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function drawMap() {
    if (!data || !svg) return;
    const W = data.width;
    const top = 110, H = 860;
    svg.setAttribute("viewBox", `0 ${top} ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid slice");

    el("path", { d: data.sea, class: "m-sea" }, svg);
    const water = el("g", {}, svg);
    data.water.forEach((d) => el("path", { d, class: "m-water" }, water));

    el("path", { d: data.roads.minor || "", class: "m-minor" }, svg);
    ["tertiary", "secondary", "primary", "major"].forEach((g) => {
      roadEls[g] = el("path", { d: data.roads[g] || "", class: `m-road m-road--${g}` }, svg);
    });

    // sea label
    const sea = el("text", { class: "m-label m-label--sea", transform: `translate(46 ${top + 640}) rotate(-90)` }, svg);
    sea.textContent = "INDIAN OCEAN";

    // route
    el("path", { d: data.route, class: "m-route-casing" }, svg);
    const route = el("path", { d: data.route, class: "m-route" }, svg);

    // stops + labels
    const stopsG = el("g", {}, svg);
    data.stops.forEach((s) => {
      const isDepot = s.order === 0;
      const g = el("g", { class: "m-stop" + (isDepot ? " m-stop--depot" : ""), transform: `translate(${s.x} ${s.y})` }, stopsG);
      el("circle", { r: isDepot ? 17 : 15 }, g);
      const t = el("text", {}, g);
      t.textContent = isDepot ? "D" : String(s.order);

      const lbl = el("text", { class: "m-label", x: s.x + 24, y: s.y + 6 }, stopsG);
      lbl.textContent = s.label;
    });

    // scale bar: 1 km = 1000 m / unitMeters
    const kmUnits = 1000 / data.unitMeters;
    const sx = W - kmUnits - 28, sy = top + 34;
    const scale = el("g", { class: "m-scale" }, svg);
    el("line", { x1: sx, y1: sy, x2: sx + kmUnits, y2: sy }, scale);
    el("line", { x1: sx, y1: sy - 5, x2: sx, y2: sy + 5 }, scale);
    el("line", { x1: sx + kmUnits, y1: sy - 5, x2: sx + kmUnits, y2: sy + 5 }, scale);
    const st = el("text", { x: sx + kmUnits / 2, y: sy - 10, "text-anchor": "middle" }, scale);
    st.textContent = "1 km";

    const km = document.getElementById("route-km");
    if (km) km.textContent = data.routeKm.toFixed(1);

    // draw-on animation for the route (final state is the static drawing,
    // so if animations are unsupported or disabled nothing is hidden)
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduce && route.animate && route.getTotalLength) {
      const len = route.getTotalLength();
      route.style.strokeDasharray = `${len} ${len}`;
      route.animate(
        [{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
        { duration: 2400, delay: 200, easing: "cubic-bezier(.45,.05,.2,1)", fill: "backwards" }
      );
      stopsG.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, delay: 1700, fill: "backwards" });
    }
  }

  // ---- Hour control ----
  const input = document.getElementById("hour");
  const readout = document.getElementById("hour-readout");
  const cellsWrap = document.getElementById("hour-cells");
  const cells = [];

  function buildCells() {
    if (!cellsWrap) return;
    for (let h = 0; h < 24; h++) {
      const c = document.createElement("span");
      const f = hourFactor(h);
      if (f < 1) c.className = "f-peak";
      else if (f > 1) c.className = "f-night";
      cellsWrap.appendChild(c);
      cells.push(c);
    }
  }

  function setHour(h) {
    const f = hourFactor(h);
    for (const g in roadEls) roadEls[g].style.stroke = band(BASE_SPEED[g] * f);
    cells.forEach((c, i) => c.classList.toggle("is-active", i === h));
    if (readout) readout.textContent = describe(h);
    if (input) input.setAttribute("aria-valuetext", describe(h));
  }

  // ---- Copy buttons ----
  function wireCopy() {
    document.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const target = document.querySelector(btn.getAttribute("data-copy"));
        if (!target) return;
        const text = target.innerText.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = "Copied";
        } catch (e) {
          btn.textContent = "Select & copy";
        }
        setTimeout(() => { btn.textContent = "Copy"; }, 1600);
      });
    });
  }

  // ---- Nav border on scroll ----
  function wireNav() {
    const nav = document.querySelector(".nav");
    if (!nav) return;
    const onScroll = () => nav.classList.toggle("is-scrolled", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  drawMap();
  buildCells();
  if (input) {
    input.addEventListener("input", () => setHour(parseInt(input.value, 10)));
    setHour(parseInt(input.value, 10));
  }
  wireCopy();
  wireNav();
})();
