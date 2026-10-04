// Initialize Date & Time constraints
document.addEventListener('DOMContentLoaded', () => {
    const dateInput = document.getElementById('planning-date');
    const startInput = document.getElementById('start-time');
    const endInput = document.getElementById('end-time');
    
    // Set min date to today and default to today
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;
    
    dateInput.min = todayStr;
    dateInput.value = todayStr;
    
    // Function to enforce time constraints if the date is today
    function enforceTimeConstraints() {
        if (dateInput.value === todayStr) {
            const now = new Date();
            const currHours = now.getHours();
            const currMins = now.getMinutes();
            
            // Format current time
            const minTimeStr = `${String(currHours).padStart(2, '0')}:${String(currMins).padStart(2, '0')}`;
            
            // If start-time is earlier than current time, force it to current time
            if (startInput.value < minTimeStr) {
                startInput.value = minTimeStr;
            }
            
            // end-time must be after start-time
            if (endInput.value <= startInput.value) {
                const endHours = Math.min(23, parseInt(startInput.value.split(':')[0]) + 4);
                endInput.value = `${String(endHours).padStart(2, '0')}:${startInput.value.split(':')[1]}`;
            }
        }
    }
    
    // Run once on load
    enforceTimeConstraints();
    
    // Add event listeners to validate dynamically
    dateInput.addEventListener('change', enforceTimeConstraints);
    startInput.addEventListener('change', enforceTimeConstraints);
});

// Initialize map centered on Colombo
const map = L.map('map').setView([39.9042, 116.4074], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
}).addTo(map);

let points = []; // Array of {lat, lon}
window.markers = [];
let routeLines = [];

// Click to add points
map.on('click', function(e) {
    // If we have existing route lines, clear them because the route is now invalid
    if (routeLines.length > 0) {
        routeLines.forEach(l => map.removeLayer(l));
        routeLines = [];
        window.routeSegmentLines = [];
        document.getElementById('val-dist').innerText = '0 km';
        document.getElementById('val-dist-old').classList.add('hidden');
        document.getElementById('badge-dist-save').classList.add('hidden');
        
        document.getElementById('val-time').innerText = '0 min';
        document.getElementById('val-time-old').classList.add('hidden');
        document.getElementById('badge-time-save').classList.add('hidden');
        
        // Reset sequence UI to just say "Needs Re-optimization"
        document.getElementById('route-steps').innerHTML = `
            <div class="text-center py-8 opacity-50">
                <span class="material-symbols-rounded text-4xl text-amber-500 mb-2">warning</span>
                <p class="text-sm font-medium text-slate-500">Route modified.</p>
                <p class="text-xs text-slate-400 mt-1">Click Optimize to recalculate.</p>
            </div>
        `;
        
        // Restore all markers to original styling (in case they were modified)
        window.markers.forEach((m, i) => {
            const isDpt = i === 0;
            const iHtml = isDpt ? 
                `<div class="w-8 h-8 bg-brand-600 rounded-full border-2 border-white shadow-lg flex items-center justify-center text-white"><span class="material-symbols-rounded text-[18px]">home</span></div>` : 
                `<div class="w-7 h-7 bg-slate-800 rounded-full border-2 border-white shadow-lg flex items-center justify-center text-white text-xs font-bold">${i}</div>`;
            m.setIcon(L.divIcon({
                className: 'custom-modern-marker bg-transparent border-0',
                html: iHtml,
                iconSize: [32, 32],
                iconAnchor: [16, 16]
            }));
        });
    }

    const lat = e.latlng.lat;
    const lon = e.latlng.lng;
    points.push({lat, lon});
    
    // Create beautiful modern marker icon
    const isDepot = points.length === 1;
    const iconHtml = isDepot ? 
        `<div class="w-8 h-8 bg-brand-600 rounded-full border-2 border-white shadow-lg flex items-center justify-center text-white"><span class="material-symbols-rounded text-[18px]">home</span></div>` : 
        `<div class="w-7 h-7 bg-slate-800 rounded-full border-2 border-white shadow-lg flex items-center justify-center text-white text-xs font-bold">${points.length - 1}</div>`;
    
    const icon = L.divIcon({
        className: 'custom-modern-marker bg-transparent border-0',
        html: iconHtml,
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    });
    
    const marker = L.marker([lat, lon], {icon: icon}).addTo(map);
    window.markers.push(marker);
    
    const emptyState = document.getElementById('empty-state');
    if (emptyState) emptyState.style.display = 'none';
    
    document.getElementById('val-drops').innerText = points.length > 1 ? points.length - 1 : 0;
});

// Clear everything
document.getElementById('btn-clear').addEventListener('click', () => {
    points = [];
    window.markers.forEach(m => map.removeLayer(m));
    window.markers = [];
    routeLines.forEach(l => map.removeLayer(l));
    routeLines = [];
    window.routeSegmentLines = [];
    document.getElementById('val-drops').innerText = '0';
    document.getElementById('val-dist').innerText = '0 km';
    document.getElementById('val-dist-old').classList.add('hidden');
    document.getElementById('badge-dist-save').classList.add('hidden');
    
    document.getElementById('val-time').innerText = '0 min';
    document.getElementById('val-time-old').classList.add('hidden');
    document.getElementById('badge-time-save').classList.add('hidden');
    document.getElementById('route-steps').innerHTML = `
        <div class="text-center py-8 opacity-50" id="empty-state">
            <span class="material-symbols-rounded text-4xl text-slate-300 mb-2">touch_app</span>
            <p class="text-sm font-medium text-slate-500">Tap the map to add delivery points.</p>
            <p class="text-xs text-slate-400 mt-1">1st pin is your logistics depot.</p>
        </div>
    `;
});

// Optimize!
document.getElementById('btn-optimize').addEventListener('click', async () => {
    if (points.length < 2) {
        alert("Please add at least a Depot and one drop-off point!");
        return;
    }
    
    // Check if planning date is today and time has passed
    const dateInput = document.getElementById('planning-date');
    const startInput = document.getElementById('start-time');
    
    if (dateInput && startInput) {
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        const todayStr = `${yyyy}-${mm}-${dd}`;
        
        if (dateInput.value === todayStr) {
            const currHours = String(today.getHours()).padStart(2, '0');
            const currMins = String(today.getMinutes()).padStart(2, '0');
            const currTimeStr = `${currHours}:${currMins}`;
            
            if (startInput.value < currTimeStr) {
                const updateTime = confirm(`The selected start time (${startInput.value}) has already passed.\n\nWould you like to automatically update the start time to the current time (${currTimeStr}) before optimizing?`);
                if (updateTime) {
                    startInput.value = currTimeStr;
                    
                    // Also bump end-time if necessary
                    const endInput = document.getElementById('end-time');
                    if (endInput && endInput.value <= currTimeStr) {
                        const endHours = Math.min(23, today.getHours() + 4);
                        endInput.value = `${String(endHours).padStart(2, '0')}:${currMins}`;
                    }
                }
            }
        }
    }
    
    document.getElementById('loading-overlay').classList.remove('hidden');
    document.getElementById('loading-overlay').classList.add('flex');
    
    try {
        const depot = points[0];
        const drops = points.slice(1);
        
        // 1. Create orders in DB
        const dropLocations = drops.map(p => [p.lon, p.lat]);
        const orderRes = await fetch('/api/v1/create-orders', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({locations: dropLocations})
        });
        const orderData = await orderRes.json();
        
        if (!orderRes.ok) {
            throw new Error(orderData.detail || "Failed to create orders");
        }
        
        const orderIds = orderData.order_ids;
        
        // Calculate max allowed duration from Start and Deadline inputs
        const startTimeVal = document.getElementById('start-time').value || "09:00";
        const endTimeVal = document.getElementById('end-time').value || "17:00";
        
        const [sHours, sMinutes] = startTimeVal.split(':');
        const [eHours, eMinutes] = endTimeVal.split(':');
        
        let startTimestamp = new Date();
        startTimestamp.setHours(parseInt(sHours), parseInt(sMinutes), 0, 0);
        
        let endTimestamp = new Date();
        endTimestamp.setHours(parseInt(eHours), parseInt(eMinutes), 0, 0);
        
        // If deadline is earlier in the day than start time, assume it's for the next day
        if (endTimestamp <= startTimestamp) {
            endTimestamp.setDate(endTimestamp.getDate() + 1);
        }
        
        const maxDurationSecs = Math.floor((endTimestamp - startTimestamp) / 1000);
        
        // 2. Call Optimize endpoint
        const optRes = await fetch('/api/v1/optimize-route', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                rider_id: 99, // Test rider
                depot_location: [depot.lon, depot.lat],
                order_ids: orderIds,
                max_duration_seconds: maxDurationSecs,
                start_hour: parseInt(sHours),
                planning_date: document.getElementById('planning-date') ? document.getElementById('planning-date').value : undefined,
                city: document.getElementById('city-selector').value
            })
        });
        
        if (!optRes.ok) {
            const err = await optRes.text();
            throw new Error(err);
        }
        
        const data = await optRes.json();
        renderRoute(data);
        
    } catch (err) {
        console.error(err);
        alert("Optimization failed: " + err.message);
    } finally {
        document.getElementById('loading-overlay').classList.add('hidden');
        document.getElementById('loading-overlay').classList.remove('flex');
    }
});

function renderRoute(data) {
    // Clear old lines
    routeLines.forEach(l => map.removeLayer(l));
    routeLines = [];
    
    const distKm = (data.total_distance_meters / 1000).toFixed(2);
    const timeMin = Math.round(data.total_duration_seconds / 60);
    
    document.getElementById('val-dist').innerText = `${distKm} km`;
    document.getElementById('val-time').innerText = `${timeMin} min`;
    
    // Handle Savings Badges
    const unoptDist = data.unoptimized_distance_meters || 0;
    const unoptTime = data.unoptimized_duration_seconds || 0;
    
    const unoptDistKm = (unoptDist / 1000).toFixed(2);
    const unoptTimeMin = Math.round(unoptTime / 60);
    
    if (unoptDist > 0 && unoptDist > data.total_distance_meters && points.length > 2) {
        document.getElementById('val-dist-old').innerText = `${unoptDistKm} km`;
        document.getElementById('val-dist-old').classList.remove('hidden');
        document.getElementById('badge-dist-save').innerText = `-${(unoptDistKm - distKm).toFixed(1)} km`;
        document.getElementById('badge-dist-save').classList.remove('hidden');
    } else {
        document.getElementById('val-dist-old').classList.add('hidden');
        document.getElementById('badge-dist-save').classList.add('hidden');
    }
    
    if (unoptTime > 0 && unoptTime > data.total_duration_seconds && points.length > 2) {
        document.getElementById('val-time-old').innerText = `${unoptTimeMin} min`;
        document.getElementById('val-time-old').classList.remove('hidden');
        document.getElementById('badge-time-save').innerText = `Saved ${unoptTimeMin - timeMin} min`;
        document.getElementById('badge-time-save').classList.remove('hidden');
    } else {
        document.getElementById('val-time-old').classList.add('hidden');
        document.getElementById('badge-time-save').classList.add('hidden');
    }
    
    // Draw lines & steps
    const stepsDiv = document.getElementById('route-steps');
    stepsDiv.innerHTML = '';
    
    const sequence = data.route_sequence;
    const latlngs = [];
    
    // Determine base start time from user input
    const dateVal = document.getElementById('planning-date').value || new Date().toISOString().split('T')[0];
    const timeVal = document.getElementById('start-time').value || "09:00";
    const [hours, minutes] = timeVal.split(':');
    
    // Parse the exact date selected (in local time)
    const [year, month, day] = dateVal.split('-');
    const startDate = new Date();
    startDate.setFullYear(parseInt(year), parseInt(month) - 1, parseInt(day));
    startDate.setHours(parseInt(hours), parseInt(minutes), 0, 0);
    const startTimestamp = startDate.getTime();
    
    sequence.forEach((step, index) => {
        if (!step.location) return;
        
        const lat = step.location[1];
        const lon = step.location[0];
        latlngs.push([lat, lon]);
        
        // Find matching marker by coordinates to update its number
        const markerIdx = points.findIndex(p => Math.abs(p.lat - lat) < 0.0001 && Math.abs(p.lon - lon) < 0.0001);
        if (markerIdx !== -1) {
            const marker = window.markers[markerIdx];
            const isDepot = step.type === 'start' || step.type === 'end';
            
            // Only update drop-off markers (don't overwrite the Depot 'D')
            if (!isDepot) {
                const icon = L.divIcon({
                    className: 'custom-modern-marker bg-transparent border-0',
                    html: `<div class="w-7 h-7 bg-brand-600 rounded-full border-2 border-white shadow-[0_4px_10px_rgba(37,99,235,0.4)] flex items-center justify-center text-white text-xs font-bold ring-2 ring-white/50">${index}</div>`, 
                    iconSize: [32, 32],
                    iconAnchor: [16, 16]
                });
                marker.setIcon(icon);
            }
            
            // Calculate ETA relative to start time
            const etaDate = new Date(startTimestamp + step.arrival * 1000);
            const etaString = etaDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            
            // Bind a popup to show when clicked from sidebar
            marker.bindPopup(`<b>${isDepot ? 'Depot' : 'Stop ' + index}</b><br>ETA: ${etaString}`);
        }
        
        // Add to sidebar with an onclick handler
        const etaDate = new Date(startTimestamp + step.arrival * 1000);
        const timeAtPoint = etaDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        const typeLabel = step.type === 'start' ? 'Start at Depot' : 
                          step.type === 'end' ? 'Return to Depot' : 
                          `Drop-off ${index} (Job ${step.job})`;
                          
        // Calculate leg distance and travel time from previous point
        let legHtml = "";
        if (index > 0) {
            const prevStep = sequence[index - 1];
            const legDistKm = ((step.distance - prevStep.distance) / 1000).toFixed(2);
            const travelSec = step.arrival - (prevStep.arrival + (prevStep.service || 0));
            const travelMin = Math.round(travelSec / 60);
            
            legHtml = `
            <div class="relative ml-4 py-3 border-l-2 border-brand-200 pl-6 group-hover:border-brand-400 transition-colors">
                <div class="absolute -left-[5px] top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-brand-300"></div>
                <div class="flex items-center text-xs font-medium text-slate-500 bg-slate-50 rounded-lg p-2 inline-flex">
                    <span class="material-symbols-rounded text-[14px] mr-1.5 text-slate-400">directions_car</span>
                    ${legDistKm} km &bull; ${travelMin} min drive
                </div>
            </div>`;
        }
        
        const serviceMin = step.service ? Math.round(step.service / 60) : 0;
        const serviceHtml = serviceMin > 0 ? `<div class="flex items-center text-amber-600 text-[11px] font-bold mt-1 bg-amber-50 px-2 py-0.5 rounded w-max"><span class="material-symbols-rounded text-[12px] mr-1">timer</span>${serviceMin}m wait</div>` : "";
        const iconType = step.type === 'start' ? 'home' : (step.type === 'end' ? 'flag' : 'location_on');
        const iconColor = step.type === 'start' ? 'text-brand-600 bg-brand-100' : 'text-slate-600 bg-slate-100';

        stepsDiv.innerHTML += `
            <div class="group cursor-pointer relative" onclick="map.setView([${lat}, ${lon}], 16); window.highlightMarker(${markerIdx}, ${index});">
                ${legHtml}
                <div class="flex items-start bg-white border border-slate-100 rounded-xl p-3 shadow-sm hover:shadow-md hover:border-brand-300 transition-all z-10 relative">
                    <div class="w-8 h-8 rounded-lg flex items-center justify-center mr-3 flex-shrink-0 ${iconColor}">
                        <span class="material-symbols-rounded text-[18px]">${iconType}</span>
                    </div>
                    <div>
                        <p class="font-bold text-slate-800 text-sm leading-tight">${typeLabel}</p>
                        <p class="text-[11px] text-slate-500 font-semibold mt-0.5">ETA: ${timeAtPoint}</p>
                        ${serviceHtml}
                    </div>
                </div>
            </div>
        `;
    });
    
    // Split geometry into segments between stops by finding closest points
    window.routeSegmentLines = [];
    let segments = [];
    
    if (data.geometry) {
        const decodedPath = decodePolyline(data.geometry);
        
        // Find the index of the closest point in the path for each step
        let stepIndices = [];
        sequence.forEach(step => {
            if (!step.location) return;
            const targetLat = step.location[1];
            const targetLon = step.location[0];
            
            let minDist = Infinity;
            let closestIdx = 0;
            // Only search forward from the last found index to keep it sequential
            const startSearchIdx = stepIndices.length > 0 ? stepIndices[stepIndices.length - 1] : 0;
            
            for (let i = startSearchIdx; i < decodedPath.length; i++) {
                const p = decodedPath[i];
                const dist = Math.pow(p[0] - targetLat, 2) + Math.pow(p[1] - targetLon, 2);
                if (dist < minDist) {
                    minDist = dist;
                    closestIdx = i;
                }
            }
            stepIndices.push(closestIdx);
        });
        
        // Slice the path into segments based on those indices
        for (let i = 1; i < stepIndices.length; i++) {
            const startIdx = stepIndices[i-1];
            // Include the end point in this segment so lines connect seamlessly
            const endIdx = stepIndices[i] + 1; 
            segments.push(decodedPath.slice(startIdx, endIdx));
        }
    } else {
        // Fallback straight line segments
        for (let i = 1; i < latlngs.length; i++) {
            segments.push([latlngs[i-1], latlngs[i]]);
        }
    }

    // Draw the segments
    segments.forEach((seg, idx) => {
        // Ensure seg has at least 2 points
        if (seg.length < 2) return;
        
        const poly = L.polyline(seg, {color: '#2563eb', weight: 6, opacity: 0.9}).addTo(map);
        routeLines.push(poly);
        
        // Add directional arrows
        const decorator = L.polylineDecorator(poly, {
            patterns: [
                {
                    offset: 35, 
                    repeat: 80, 
                    symbol: L.Symbol.arrowHead({pixelSize: 14, pathOptions: {fillOpacity: 1, color: '#1e3a8a', weight: 2}})
                }
            ]
        }).addTo(map);
        routeLines.push(decorator);
        
        window.routeSegmentLines.push({line: poly, decorator: decorator});
    });

    // Zoom to fit all lines
    if (latlngs.length > 0) {
        const fullLine = L.polyline(latlngs);
        map.fitBounds(fullLine.getBounds(), {padding: [50, 50]});
    }
}

// Standard Google Polyline Decoder algorithm
function decodePolyline(str, precision = 5) {
    let index = 0, lat = 0, lng = 0, coordinates = [];
    let shift = 0, result = 0, byte = null, latitude_change, longitude_change, factor = Math.pow(10, precision);

    while (index < str.length) {
        byte = null; shift = 0; result = 0;
        do {
            byte = str.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);
        latitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));
        shift = result = 0;
        do {
            byte = str.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);
        longitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));

        lat += latitude_change;
        lng += longitude_change;
        coordinates.push([lat / factor, lng / factor]);
    }
    return coordinates;
}

window.highlightMarker = function(markerIdx, sequenceIdx) {
    // 1. Handle Marker Popup
    if (markerIdx !== null && window.markers[markerIdx]) {
        const m = window.markers[markerIdx];
        setTimeout(() => m.openPopup(), 300);
    }
    
    // 2. Handle Line Segment Highlighting
    if (window.routeSegmentLines) {
        window.routeSegmentLines.forEach((segmentObj, idx) => {
            const line = segmentObj.line;
            const decorator = segmentObj.decorator;
            
            if (sequenceIdx !== null) {
                // If a step is clicked, highlight the line leading up to it (sequenceIdx - 1)
                if (idx === sequenceIdx - 1) {
                    if (!map.hasLayer(line)) map.addLayer(line);
                    if (!map.hasLayer(decorator)) map.addLayer(decorator);
                    line.setStyle({color: '#ef4444', weight: 8, opacity: 1.0}); // Red, thicker
                } else {
                    if (map.hasLayer(line)) map.removeLayer(line);
                    if (map.hasLayer(decorator)) map.removeLayer(decorator);
                }
            } else {
                // Reset all lines to default
                if (!map.hasLayer(line)) map.addLayer(line);
                if (!map.hasLayer(decorator)) map.addLayer(decorator);
                line.setStyle({color: '#2563eb', weight: 6, opacity: 0.9});
            }
        });
    }
};

// Reset highlights if clicking empty map space
map.on('click', function(e) {
    setTimeout(() => {
        if (!map._popup) {
            window.highlightMarker(null, null);
        }
    }, 100);
});

// Handle City Change Dropdown
document.getElementById('city-selector').addEventListener('change', function(e) {
    const coords = {
        'beijing': [39.9042, 116.4074],
        'colombo': [6.9271, 79.8612],
        'porto': [41.1579, -8.6291],
        'california': [37.7749, -122.4194]
    };
    
    if (coords[e.target.value]) {
        // Clear all markers and lines when switching city
        if (document.getElementById('btn-clear')) {
            document.getElementById('btn-clear').click();
        }
        
        // Fly to new location
        map.flyTo(coords[e.target.value], 13, {
            animate: true,
            duration: 1.5
        });
    }
});
