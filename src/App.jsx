import { useEffect, useRef, useState, useCallback } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import MaplibreGeocoder from "@maplibre/maplibre-gl-geocoder"
import "@maplibre/maplibre-gl-geocoder/dist/maplibre-gl-geocoder.css"

// ── Helpers outside the component ──────────────────────────────────────────

async function geocodeQuery(query) {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=geojson&limit=5`
  )
  const data = await res.json()
  return data.features.map(f => ({
    type: 'Feature',
    geometry: f.geometry,
    place_name: f.properties.display_name,
    center: f.geometry.coordinates,
    place_type: ['place']
  }))
}

async function fetchRoute(from, to) {
  const url = `https://router.project-osrm.org/route/v1/driving/${from[0]},${from[1]};${to[0]},${to[1]}?overview=full&geometries=geojson&steps=true`
  const res = await fetch(url)
  const data = await res.json()
  if (!data.routes?.length) throw new Error('No route found')
  return data.routes[0]
}

function formatDist(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`
}

function formatTime(s) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}min` : `${m} min`
}

function speak(text) {
  if (!window.speechSynthesis) return
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = 'en-US'
  u.rate = 1.05
  window.speechSynthesis.speak(u)
}

const TURN_ICONS = {
  'turn-left': '↰', 'turn-right': '↱',
  'turn-slight-left': '↖', 'turn-slight-right': '↗',
  'turn-sharp-left': '◁', 'turn-sharp-right': '▷',
  'uturn-left': '↩', 'uturn-right': '↪',
  'roundabout': '⟳', 'rotary': '⟳',
  'arrive': '📍', 'depart': '🚀',
}

function turnIcon(maneuver) {
  if (!maneuver) return '→'
  const key = `${maneuver.type}${maneuver.modifier ? '-' + maneuver.modifier : ''}`
  return TURN_ICONS[key] || TURN_ICONS[maneuver.type] || '→'
}

// ── Main component ──────────────────────────────────────────────────────────

export default function App() {
  const mapInstanceRef = useRef(null)
  const fromMarkerRef = useRef(null)
  const toMarkerRef = useRef(null)
  const clickModeRef = useRef(null)
  const searchDebounce = useRef({})

  const [fromCoords, setFromCoords] = useState(null)
  const [toCoords, setToCoords] = useState(null)
  const [fromLabel, setFromLabel] = useState('')
  const [toLabel, setToLabel] = useState('')
  const [route, setRoute] = useState(null)
  const [steps, setSteps] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [clickMode, setClickMode] = useState(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [voiceOn, setVoiceOn] = useState(true)
  const [fromSuggestions, setFromSuggestions] = useState([])
  const [toSuggestions, setToSuggestions] = useState([])
  const [darkMode, setDarkMode] = useState(false)
  const [activeStep, setActiveStep] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)

  // keep ref in sync so map click handler can always read latest value
  useEffect(() => { clickModeRef.current = clickMode }, [clickMode])

  // Dark Mode Switch
useEffect(() => {
  const map = mapInstanceRef.current
  if (!map) return
  
  map.setStyle(
    darkMode
      ? 'https://tiles.openfreemap.org/styles/dark'
      : 'https://tiles.openfreemap.org/styles/liberty'
  )



  map.once('styledata', () => {
    if (darkMode) {
      const textLayers = [
        'highway_name_other', 'highway_name_motorway', 'place_other',
        'place_suburb', 'place_village', 'place_town', 'place_city',
        'place_city_large', 'place_state', 'place_country_other',
        'place_country_minor', 'place_country_major'
      ]
      textLayers.forEach(l => {
        try { map.setPaintProperty(l, 'text-color', '#ffffff') } catch (_) {}
      })
    }
    
    try {
      map.addLayer({
        id: '3d-buildings',
        source: 'openmaptiles',
        'source-layer': 'building',
        type: 'fill-extrusion',
        minzoom: 0,
        paint: {
          'fill-extrusion-color': darkMode ? '#0d2137' : '#c8d4e8',
          'fill-extrusion-height': ['get', 'render_height'],
          'fill-extrusion-base': ['get', 'render_min_height'],
          'fill-extrusion-opacity': 0.9
        }
      })
    } catch (_) {}

    try {
      map.addSource('tomtom-traffic', {
        type: 'vector',
        tiles: [`https://api.tomtom.com/traffic/map/4/tile/flow/relative/{z}/{x}/{y}.pbf?key=9TbI9IRXkgysw41l3XfrCucB6yjGEvyV`],
        maxzoom: 14
      })
      map.addLayer({
        id: 'traffic-flow',
        type: 'line',
        source: 'tomtom-traffic',
        'source-layer': 'Traffic flow',
        minzoom: 8,
        paint: {
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 13, 3, 16, 5],
          'line-color': [
            'case',
            ['==', ['get', 'road_closure'], true], '#ff00ff',
            ['!', ['has', 'traffic_level']], '#333333',
            ['<=', ['get', 'traffic_level'], 0.15], '#00ff88',
            ['<=', ['get', 'traffic_level'], 0.3], '#a8ff00',
            ['<=', ['get', 'traffic_level'], 0.6], '#ffcc00',
            ['<=', ['get', 'traffic_level'], 0.8], '#ff6600',
            '#33d6ff'
          ]
        }
      }, 'highway_name_other')
    } catch (_) {}

    try {
  map.addLayer({
    id: 'poi-labels',
    source: 'openmaptiles',
    'source-layer': 'poi',
    type: 'symbol',
    minzoom: 14,
    layout: {
      'text-field': ['get', 'name'],
      'text-size': 11,
      'text-offset': [0, 1],
      'icon-image': ['get', 'class'],
      'text-anchor': 'top'
    },
    paint: {
      'text-color': darkMode ? '#ffffff' : '#333333',
      'text-halo-color': darkMode ? '#000000' : '#ffffff',
      'text-halo-width': 1
    }
  })
} catch (_) {}

    try {
      map.addSource('route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      })
      map.addLayer({
        id: 'route-outline', type: 'line', source: 'route',
        paint: { 'line-color': '#000', 'line-width': 10, 'line-opacity': 0.4 }
      })
      map.addLayer({
        id: 'route-line', type: 'line', source: 'route',
        paint: { 'line-color': '#4f8ef7', 'line-width': 6, 'line-opacity': 0.95 }
      })
    } catch (_) {}
  })
}, [darkMode])


  // ── Map init ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const map = new maplibregl.Map({
      container: 'map',
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [13.4050, 52.5200],
      zoom: 11,
      pitch: 0,
      bearing: 0,
      pixelRatio: window.devicePixelRatio || 2,
      dragPan: { linearity: 0.3, maxSpeed: 1400, deceleration: 2500 }
    })
    mapInstanceRef.current = map

    map.on('load', () => {
      // GPS center
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => map.flyTo({
          center: [coords.longitude, coords.latitude],
          zoom: 14,
          duration: 2000
        }),
        () => console.log('Location access denied')
      )

      addCustomLayers(map, false)

      // Text colors
      const textLayers = [
        'highway_name_other', 'highway_name_motorway', 'place_other',
        'place_suburb', 'place_village', 'place_town', 'place_city',
        'place_city_large', 'place_state', 'place_country_other',
        'place_country_minor', 'place_country_major'
      ]
      textLayers.forEach(l => {
        try { map.setPaintProperty(l, 'text-color', '#ffffff') } catch (_) {}
      })
      try { map.setPaintProperty('water_name', 'text-color', '#4fc3f7') } catch (_) {}


  function addCustomLayers(map, darkMode) {
    if (darkMode) {
      const textLayers = [
        'highway_name_other', 'highway_name_motorway', 'place_other',
        'place_suburb', 'place_village', 'place_town', 'place_city',
        'place_city_large', 'place_state', 'place_country_other',
        'place_country_minor', 'place_country_major'
      ]
      textLayers.forEach(i => {
        try { map.setPaintProperty(i, "text-color", "#ffffff") } catch (_) {}
      })
    }
  }  
  

      // 3D Buildings
     try { 
      map.addLayer({
        id: '3d-buildings',
        source: 'openmaptiles',
        'source-layer': 'building',
        type: 'fill-extrusion',
        minzoom: 0,
        paint: {
          'fill-extrusion-color': darkMode ? '#0d2137': "#ffffff",
          'fill-extrusion-height': ['get', 'render_height'],
          'fill-extrusion-base': ['get', 'render_min_height'],
          'fill-extrusion-opacity': 0.9
        }
      })
    } catch (_) {} 

      // Traffic
    try {  
      map.addSource('tomtom-traffic', {
        type: 'vector',
        tiles: [`https://api.tomtom.com/traffic/map/4/tile/flow/relative/{z}/{x}/{y}.pbf?key=9TbI9IRXkgysw41l3XfrCucB6yjGEvyV`],
        maxzoom: 14
      })
      map.addLayer({
        id: 'traffic-flow',
        type: 'line',
        source: 'tomtom-traffic',
        'source-layer': 'Traffic flow',
        minzoom: 8,
        paint: {
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 13, 3, 16, 5],
          'line-color': [
            'case',
            ['==', ['get', 'road_closure'], true], '#ff00ff',
            ['!', ['has', 'traffic_level']], '#333333',
            ['<=', ['get', 'traffic_level'], 0.15], '#00ff88',
            ['<=', ['get', 'traffic_level'], 0.3], '#a8ff00',
            ['<=', ['get', 'traffic_level'], 0.6], '#ffcc00',
            ['<=', ['get', 'traffic_level'], 0.8], '#ff6600',
            '#33d6ff'
          ]
        }
      }, 'highway_name_other')
    } catch (_) {}  

      // Route layers (empty at start, filled when route is calculated)
    try {  
      map.addSource('route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      })
      map.addLayer({
        id: 'route-outline', type: 'line', source: 'route',
        paint: { 'line-color': '#000', 'line-width': 10, 'line-opacity': 0.4 }
      })
      map.addLayer({
        id: 'route-line', type: 'line', source: 'route',
        paint: { 'line-color': '#4f8ef7', 'line-width': 6, 'line-opacity': 0.95 }
      })
    } catch (_) {}  
   
      // Click to set from/to point
      map.on('click', (e) => {
        const mode = clickModeRef.current
        if (!mode) return
        const coords = [e.lngLat.lng, e.lngLat.lat]
        if (mode === 'from') {
          setFromCoords(coords)
          setFromLabel(`${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}`)
        } else {
          setToCoords(coords)
          setToLabel(`${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}`)
        }
        setClickMode(null)
      })

      // Map search bar (top-left, just for browsing the map)
      const geocoderApi = {
        forwardGeocode: async (config) => ({ features: await geocodeQuery(config.query) })
      }
      const geocoder = new MaplibreGeocoder(geocoderApi, {
        maplibregl,
        placeholder: 'Search city...',
        collapsed: false,
      })
      map.addControl(geocoder, 'top-left')
    })

    return () => map.remove()
  }, [])

  // ── From marker ───────────────────────────────────────────────────────────

  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return
    fromMarkerRef.current?.remove()
    if (fromCoords) {
      const el = document.createElement('div')
      el.className = 'marker-from'
      fromMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat(fromCoords)
        .addTo(map)
    }
  }, [fromCoords])

  // ── To marker ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return
    toMarkerRef.current?.remove()
    if (toCoords) {
      const el = document.createElement('div')
      el.className = 'marker-to'
      toMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat(toCoords)
        .addTo(map)
    }
  }, [toCoords])

  // ── Auto-route when both points are set ───────────────────────────────────

  useEffect(() => {
    if (!fromCoords || !toCoords) return
    const map = mapInstanceRef.current
    if (!map || !map.getSource('route')) return

    setLoading(true)
    setError('')

    fetchRoute(fromCoords, toCoords).then(r => {
      setRoute(r)
      const allSteps = r.legs.flatMap(l => l.steps)
      setSteps(allSteps)
      setActiveStep(0)
      setPanelOpen(true)

      // Draw the route on the map
      map.getSource('route').setData(r.geometry)

      // Zoom map to fit the whole route
      const coords = r.geometry.coordinates
      const bounds = coords.reduce(
        (b, c) => b.extend(c),
        new maplibregl.LngLatBounds(coords[0], coords[0])
      )
      map.fitBounds(bounds, { padding: { top: 80, bottom: 80, left: 420, right: 80 } })

      if (voiceOn) speak(`Route found. ${formatTime(r.duration)}, ${formatDist(r.distance)}. ${allSteps[0]?.maneuver?.instruction || ''}`)
    }).catch(() => {
      setError('Could not find a route. Try different points.')
    }).finally(() => setLoading(false))
  }, [fromCoords, toCoords])

  // ── GPS button handler ────────────────────────────────────────────────────

  const useGPS = useCallback(() => {
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const c = [coords.longitude, coords.latitude]
        setFromCoords(c)
        setFromLabel('My Location')
        mapInstanceRef.current?.flyTo({ center: c, zoom: 14, duration: 1500 })
      },
      () => setError('Location access denied')
    )
  }, [])

  // ── Search with debounce (waits 400ms after you stop typing) ─────────────

  const handleSearch = useCallback((val, field) => {
    if (field === 'from') setFromLabel(val)
    else setToLabel(val)

    clearTimeout(searchDebounce.current[field])
    if (val.length < 3) {
      if (field === 'from') setFromSuggestions([])
      else setToSuggestions([])
      return
    }
    searchDebounce.current[field] = setTimeout(async () => {
      const results = await geocodeQuery(val)
      if (field === 'from') setFromSuggestions(results)
      else setToSuggestions(results)
    }, 400)
  }, [])

  // ── Pick a suggestion from dropdown ──────────────────────────────────────

  const pickSuggestion = useCallback((feature, field) => {
    const coords = feature.center
    const label = feature.place_name
    if (field === 'from') {
      setFromCoords(coords)
      setFromLabel(label)
      setFromSuggestions([])
      mapInstanceRef.current?.flyTo({ center: coords, zoom: 13, duration: 1200 })
    } else {
      setToCoords(coords)
      setToLabel(label)
      setToSuggestions([])
      mapInstanceRef.current?.flyTo({ center: coords, zoom: 13, duration: 1200 })
    }
  }, [])

  // ── Clear everything ──────────────────────────────────────────────────────

  const clearRoute = useCallback(() => {
    setFromCoords(null); setToCoords(null)
    setFromLabel(''); setToLabel('')
    setRoute(null); setSteps([])
    setPanelOpen(false); setError('')
    fromMarkerRef.current?.remove()
    toMarkerRef.current?.remove()
    const map = mapInstanceRef.current
    if (map?.getSource('route')) {
      map.getSource('route').setData({ type: 'FeatureCollection', features: [] })
    }
  }, [])

  // ── Click a step → fly to it + speak it ──────────────────────────────────

  const stepClick = useCallback((step, i) => {
    setActiveStep(i)
    const loc = step.maneuver?.location
    if (loc) mapInstanceRef.current?.flyTo({ center: loc, zoom: 16, duration: 800 })
    if (voiceOn) speak(step.maneuver?.instruction || '')
  }, [voiceOn])

  // ── Crosshair cursor when in click mode ──────────────────────────────────

  useEffect(() => {
    document.body.style.cursor = clickMode ? 'crosshair' : ''
  }, [clickMode])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div id="map" style={{ width: '100dvw', height: '100dvh' }} />
      
      <button className="hamburger-btn" onClick={() => setMenuOpen(m => !m)}>
        {menuOpen ? '✕' : '☰'}
          </button>

      {/* Nav Panel */}
      <div className={`nav-panel ${panelOpen ? 'open' : ''}`}>

        <div className="nav-header">
          <span className="nav-title">🗺️ Navigation</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="icon-btn" onClick={() => setVoiceOn(v => !v)}>
              {voiceOn ? '🔊' : '🔇'}
            </button>
            <button className="icon-btn" onClick={clearRoute}>✕</button>
          </div>
        </div>

        <div className="inputs">
          {/* FROM */}
          <div className="input-row">
            <span className="dot from-dot" />
            <div className="input-wrap">
              <input
                className="nav-input"
                placeholder="From..."
                value={fromLabel}
                onChange={e => handleSearch(e.target.value, 'from')}
              />
              {fromSuggestions.length > 0 && (
                <ul className="suggestions-list">
                  {fromSuggestions.map((f, i) => (
                    <li key={i} onClick={() => pickSuggestion(f, 'from')}>{f.place_name}</li>
                  ))}
                </ul>
              )}
            </div>
            <button className="icon-btn" title="Use GPS" onClick={useGPS}>📍</button>
            <button
              className={`icon-btn ${clickMode === 'from' ? 'active' : ''}`}
              onClick={() => setClickMode(m => m === 'from' ? null : 'from')}
            >🖱️</button>
          </div>

          {/* TO */}
          <div className="input-row">
            <span className="dot to-dot" />
            <div className="input-wrap">
              <input
                className="nav-input"
                placeholder="To..."
                value={toLabel}
                onChange={e => handleSearch(e.target.value, 'to')}
              />
              {toSuggestions.length > 0 && (
                <ul className="suggestions-list">
                  {toSuggestions.map((f, i) => (
                    <li key={i} onClick={() => pickSuggestion(f, 'to')}>{f.place_name}</li>
                  ))}
                </ul>
              )}
            </div>
            <button
              className={`icon-btn ${clickMode === 'to' ? 'active' : ''}`}
              onClick={() => setClickMode(m => m === 'to' ? null : 'to')}
            >🖱️</button>
          </div>
        </div>

        {loading && <div className="route-summary">⏳ Calculating route...</div>}
        {error && <div className="route-summary error">{error}</div>}
        {route && !loading && (
          <div className="route-summary">
            <span>🕐 {formatTime(route.duration)}</span>
            <span>📏 {formatDist(route.distance)}</span>
          </div>
        )}

        {steps.length > 0 && (
          <div className="steps-list">
            {steps.map((step, i) => (
              <div
                key={i}
                className={`step ${i === activeStep ? 'active-step' : ''}`}
                onClick={() => stepClick(step, i)}
              >
                <span className="step-icon">{turnIcon(step.maneuver)}</span>
                <div className="step-info">
                  <div className="step-instruction">{step.maneuver?.instruction || 'Continue'}</div>
                  <div className="step-dist">{formatDist(step.distance)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>


      {/* Hamburger Menu Button */}
<button className="hamburger-btn" onClick={() => setMenuOpen(m => !m)}>
  {menuOpen ? '✕' : '☰'}
</button>

{/* Dropdown Menu */}
{menuOpen && (
  <div className="dropdown-menu">
    <button className="menu-item" onClick={() => { setPanelOpen(true); setMenuOpen(false) }}>
      🧭 Navigate
    </button>
    <button className="menu-item" onClick={() => setDarkMode(d => !d)}>
      {darkMode ? '☀️ Light Mode' : '🌙 Dark Mode'}
    </button>
    <div className="menu-divider" />
    <div className="menu-label">Traffic Colors</div>
    <div className="legend">
      <div className="legend-item"><span className="legend-dot" style={{background:'#00ff88'}}/>Free</div>
      <div className="legend-item"><span className="legend-dot" style={{background:'#ffcc00'}}/>Slow</div>
      <div className="legend-item"><span className="legend-dot" style={{background:'#ff6600'}}/>Heavy</div>
      <div className="legend-item"><span className="legend-dot" style={{background:'#ff3366'}}/>Jam</div>
      <div className="legend-item"><span className="legend-dot" style={{background:'#ff00ff'}}/>Closed</div>
    </div>
  </div>
)}  


      {/* Open panel button (shown when panel is closed) */}
      {menuOpen && (
  <div className="dropdown-menu">
    <button className="menu-item" onClick={() => { setPanelOpen(true); setMenuOpen(false) }}>
      🧭 Navigate
    </button>
    <button className="menu-item" onClick={() => setDarkMode(d => !d)}>
      {darkMode ? '☀️ Light Mode' : '🌙 Dark Mode'}
    </button>
    <div className="menu-divider" />
    <div className="menu-label">Traffic Colors</div>
    <div className="legend">
      <div className="legend-item"><span className="legend-dot" style={{background:'#00ff88'}}/>Free</div>
      <div className="legend-item"><span className="legend-dot" style={{background:'#ffcc00'}}/>Slow</div>
      <div className="legend-item"><span className="legend-dot" style={{background:'#ff6600'}}/>Heavy</div>
      <div className="legend-item"><span className="legend-dot" style={{background:'#ff3366'}}/>Jam</div>
      <div className="legend-item"><span className="legend-dot" style={{background:'#ff00ff'}}/>Closed</div>
    </div>
  </div>
)}

      {/* Click mode hint at the bottom */}
      {clickMode && (
        <div className="click-hint">
          Click anywhere on the map to set {clickMode === 'from' ? 'starting point' : 'destination'}
          <button onClick={() => setClickMode(null)}>Cancel</button>
        </div>
      )}
    </>
  )
}