"""
Build compact SVG path data for the hero map from OpenStreetMap (Overpass) + an OSRM trip.
Outputs assets/map-data.js which defines window.COLOMBO_MAP.

Projection: equirectangular, 1 SVG unit = 10 m. Bounding box is central Colombo.
"""
import json
import math
import sys
from collections import defaultdict

OSM = sys.argv[1]
TRIP = sys.argv[2]
OUT = sys.argv[3]

MIN_LON, MAX_LON = 79.835, 79.905
MIN_LAT, MAX_LAT = 6.865, 6.955
LAT0 = math.radians((MIN_LAT + MAX_LAT) / 2)
M_PER_DEG_LAT = 110_574
M_PER_DEG_LON = 111_320 * math.cos(LAT0)
UNIT_M = 10.0

W = (MAX_LON - MIN_LON) * M_PER_DEG_LON / UNIT_M
H = (MAX_LAT - MIN_LAT) * M_PER_DEG_LAT / UNIT_M


def proj(lon, lat):
    x = (lon - MIN_LON) * M_PER_DEG_LON / UNIT_M
    y = (MAX_LAT - lat) * M_PER_DEG_LAT / UNIT_M
    return (x, y)


def dp(points, eps):
    """Douglas-Peucker simplification."""
    if len(points) < 3:
        return points
    (x1, y1), (x2, y2) = points[0], points[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = math.hypot(dx, dy) or 1e-9
    dmax, idx = 0.0, 0
    for i in range(1, len(points) - 1):
        px, py = points[i]
        d = abs(dy * px - dx * py + x2 * y1 - y2 * x1) / norm
        if d > dmax:
            dmax, idx = d, i
    if dmax > eps:
        left = dp(points[: idx + 1], eps)
        right = dp(points[idx:], eps)
        return left[:-1] + right
    return [points[0], points[-1]]


def fmt(v):
    s = f"{v:.1f}"
    return s[:-2] if s.endswith(".0") else s


def to_path(points, close=False):
    if len(points) < 2:
        return ""
    out = [f"M{fmt(points[0][0])} {fmt(points[0][1])}"]
    for x, y in points[1:]:
        out.append(f"L{fmt(x)} {fmt(y)}")
    if close:
        out.append("Z")
    return "".join(out)


def in_view(points, pad=60):
    return any(-pad <= x <= W + pad and -pad <= y <= H + pad for x, y in points)


data = json.load(open(OSM))
road_groups = {
    "major": {"motorway", "trunk", "motorway_link", "trunk_link"},
    "primary": {"primary", "primary_link"},
    "secondary": {"secondary", "secondary_link"},
    "tertiary": {"tertiary"},
    "minor": {"residential", "unclassified"},
}
cls_to_group = {c: g for g, cs in road_groups.items() for c in cs}
eps_by_group = {"major": 1.0, "primary": 1.0, "secondary": 1.2, "tertiary": 1.4, "minor": 2.0}

roads = defaultdict(list)
water = []
coast_ways = []

for el in data["elements"]:
    tags = el.get("tags", {})
    if el["type"] == "way" and "geometry" in el:
        pts = [proj(p["lon"], p["lat"]) for p in el["geometry"]]
        hw = tags.get("highway")
        if hw in cls_to_group:
            if not in_view(pts):
                continue
            g = cls_to_group[hw]
            roads[g].append(to_path(dp(pts, eps_by_group[g])))
        elif tags.get("natural") == "coastline":
            coast_ways.append([(p["lon"], p["lat"]) for p in el["geometry"]])
        elif tags.get("natural") == "water" or tags.get("waterway") == "riverbank":
            if len(pts) > 3 and in_view(pts, 0):
                water.append(to_path(dp(pts, 1.0), close=True))
    elif el["type"] == "relation" and tags.get("natural") == "water":
        for m in el.get("members", []):
            if m.get("role") == "outer" and "geometry" in m:
                pts = [proj(p["lon"], p["lat"]) for p in m["geometry"]]
                if len(pts) > 3 and in_view(pts, 0):
                    water.append(to_path(dp(pts, 1.0), close=True))

# --- Assemble coastline chains by joining matching endpoints ---
chains = [list(w) for w in coast_ways]
merged = True
while merged:
    merged = False
    for i in range(len(chains)):
        for j in range(len(chains)):
            if i == j:
                continue
            if chains[i][-1] == chains[j][0]:
                chains[i] = chains[i] + chains[j][1:]
                del chains[j]
                merged = True
                break
        if merged:
            break

chains.sort(key=len, reverse=True)
coast = [proj(lon, lat) for lon, lat in chains[0]]
coast = dp(coast, 1.0)
# OSM coastline has land on the left, so for Sri Lanka's west coast the line runs north -> south... or the
# reverse. Either way, closing it far to the west produces the sea polygon.
far_w = -400
sea = coast + [(far_w, coast[-1][1]), (far_w, coast[0][1])]
sea_path = to_path(sea, close=True)

# --- Route from OSRM trip ---
trip = json.load(open(TRIP))
route_pts = [proj(lon, lat) for lon, lat in trip["trips"][0]["geometry"]["coordinates"]]
route_path = to_path(dp(route_pts, 0.6))
labels = {
    0: "Depot · Borella",
    1: "Havelock Town",
    2: "Wellawatte",
    3: "Bambalapitiya",
    4: "Kollupitiya",
    5: "Fort",
    6: "Pettah",
}
stops = []
for wp in trip["waypoints"]:
    x, y = proj(*wp["location"])
    order = wp["waypoint_index"]
    stops.append({"order": order, "x": round(x, 1), "y": round(y, 1), "label": labels.get(order, "")})
stops.sort(key=lambda s: s["order"])

out = {
    "width": round(W, 1),
    "height": round(H, 1),
    "unitMeters": UNIT_M,
    "sea": sea_path,
    "water": water,
    "roads": {g: " ".join(p for p in paths if p) for g, paths in roads.items()},
    "route": route_path,
    "routeKm": round(trip["trips"][0]["distance"] / 1000, 1),
    "stops": stops,
    "osmTimestamp": data["osm3s"]["timestamp_osm_base"],
}

with open(OUT, "w") as f:
    f.write("/* Generated from OpenStreetMap data (c) OpenStreetMap contributors, ODbL.\n")
    f.write("   Route geometry from the OSRM demo server. Regenerate with scripts/build_map_data.py. */\n")
    f.write("window.COLOMBO_MAP = ")
    json.dump(out, f, separators=(",", ":"))
    f.write(";\n")

sizes = {g: len(v) for g, v in out["roads"].items()}
print("viewBox", out["width"], out["height"], "roads chars", sizes, "water", len(water), "coast chains", len(chains))
