# Noera — ονόματα σε 3D πάνω από πρόσωπα (PWA, 100% στη συσκευή)

[English below](#english)

## Τι κάνει
- **Καταχώριση:** ανοίγει την μπροστινή κάμερα, τραβά μερικές λήψεις του προσώπου (ευθεία, πλάγια, πάνω/κάτω) και τις αποθηκεύει με ένα όνομα στη μνήμη του κινητού (IndexedDB). Όσα άτομα θέλεις.
- **Κύρια οθόνη:** ανοίγει την κάμερα και, όταν δει άτομο που υπάρχει στη μνήμη, δείχνει το όνομά του με **τρισδιάστατα γράμματα** πάνω από το κεφάλι, που γυρίζουν μαζί με το κεφάλι. Δουλεύει για **όλα τα πρόσωπα στην οθόνη ταυτόχρονα** (έως 12).
- **Ρυθμίσεις (👥):** λίστα ατόμων, μετονομασία, διαγραφή, «+ λήψεις» σε υπάρχον άτομο, διαγραφή όλων, εξαγωγή/εισαγωγή αντιγράφου (JSON), αυστηρότητα αναγνώρισης, εμβέλεια ανίχνευσης, «?» σε άγνωστους, ένδειξη ταχύτητας.
- **Ιδιωτικότητα:** τίποτα δεν φεύγει από το κινητό. Μοντέλα, κώδικας και δεδομένα τρέχουν και μένουν τοπικά. Μετά το πρώτο άνοιγμα δουλεύει και χωρίς internet.

## Πώς το ανοίγω
1. Άνοιξε το link (https) σε **Safari (iPhone)** ή **Chrome (Android)**.
2. Πάτα «📷 Άνοιγμα κάμερας» και δώσε άδεια κάμερας.
3. Προαιρετικά: «Προσθήκη στην οθόνη αφετηρίας» (Safari: κουμπί κοινοποίησης → Προσθήκη στην οθόνη αφετηρίας. Chrome: ⋮ → Εγκατάσταση εφαρμογής).
4. 🔄 πάνω δεξιά = αλλαγή μπροστινής/πίσω κάμερας.
5. ⚪ κάτω στο κέντρο = στιγμιότυπο (εικόνα της κάμερας μαζί με τα ονόματα / 3D αντικείμενα). Στο κινητό ανοίγει η κοινοποίηση για «Αποθήκευση» στη συλλογή, αλλού κατεβαίνει ως `noera-ΕΕΕΕΜΜΗΗ-ΩΩΛΛΔΔ.png`.

**Φιλοξενία:** η κάμερα θέλει **https**. Ανέβασε τον φάκελο (ή το zip αποσυμπιεσμένο) σε οποιαδήποτε στατική φιλοξενία https, π.χ. Netlify Drop, GitHub Pages ή Cloudflare Pages. Στον υπολογιστή: `python3 serve.py` και μετά http://localhost:8080. Μετά το πρώτο άνοιγμα δουλεύει και χωρίς internet, μέσω service worker.

## Πώς καταχωρίζω κάποιον
1. «＋ Νέο άτομο» → γράψε όνομα (ελληνικά ή λατινικά).
2. Πάτα **«▶ Αυτόματη λήψη»** και ακολούθησε τις οδηγίες: κοίτα ευθεία → γύρνα αργά το κεφάλι προς τη μία πλευρά → προς την άλλη → πηγούνι πάνω/κάτω. Ή «📸 Μία λήψη» όσες φορές θες, ή «🖼 Από φωτογραφία».
3. «Αποθήκευση».

**Συμβουλές:** καλό φως στο πρόσωπο, χωρίς γυαλιά ηλίου/μάσκα, πρόσωπο να γεμίζει περίπου το 1/3 της οθόνης. Για καλύτερη αναγνώριση από πλάι, πρόσθεσε λήψεις με το κεφάλι γυρισμένο (👥 → «+ λήψεις»), ιδανικά και με το πίσω κινητό/άλλο φως. Αν μπερδεύει άτομα, ανέβασε την αυστηρότητα (π.χ. 0.45–0.50). Αν δεν αναγνωρίζει εύκολα, κατέβασέ την (0.35) ή πρόσθεσε λήψεις. Για ομάδες σε απόσταση, βάλε «Εμβέλεια: Μακριά».

## Ειλικρινή όρια
- **Πλάγια:** μέχρι ~45° γυρισμένο κεφάλι αναγνωρίζεται καλά. Σε **σχεδόν προφίλ (>60°)** το πρόσωπο συνήθως ανιχνεύεται (δείχνει «?») αλλά **δεν αναγνωρίζεται** αξιόπιστα. Αν όμως ένα άτομο αναγνωριστεί και μετά γυρίσει, το όνομα **μένει** πάνω του όσο το ακολουθεί η κάμερα.
- Μάσκες, γυαλιά ηλίου, πολύ χαμηλό φως, θόλωμα κίνησης, πολύ μικρά/μακρινά πρόσωπα (<~40 px) → αποτυχία ή «?».
- Μπορεί να γίνουν **λάθη** (π.χ. συγγενείς που μοιάζουν, δίδυμα). Ρύθμισε την αυστηρότητα.
- Δεν είναι εργαλείο ασφαλείας/ταυτοποίησης. Μόνο για διασκέδαση.
- Η ταχύτητα εξαρτάται από το κινητό: σε σύγχρονα κινητά περιμένουμε ~15–30 fps. Σε παλιά, διάλεξε «Εμβέλεια: Κοντά».
- Τα δεδομένα είναι σε αυτόν τον browser μόνο: αν «καθαρίσεις δεδομένα ιστοτόπων» χάνονται. Κάνε «Εξαγωγή» για αντίγραφο. Το αρχείο αντιγράφου περιέχει τα «αποτυπώματα» προσώπων: κράτα το ιδιωτικό.

## Ιδιωτικότητα / συναίνεση
Καταχώρισε **μόνο άτομα που συμφωνούν**. Τα βιομετρικά δεδομένα (ακόμα και τα αριθμητικά «αποτυπώματα» που κρατά η εφαρμογή) είναι ευαίσθητα. Μην τη χρησιμοποιείς σε αγνώστους ή δημόσια.

---

<a id="english"></a>
# Noera — 3D name labels above recognised faces (on-device PWA)

## Features
- **Enroll:** front camera, guided multi-angle capture (straight, side, other side, chin up/down), plus single-shot or from-photo. Stored under a name in IndexedDB. Many people.
- **Scan:** live camera; every recognised face (up to 12 at once) gets its name as extruded, bevelled, lit **3D text** that floats above the head, follows it with low-pass smoothing and tilts with the head pose.
- **People/settings:** rename, delete, add more captures, delete all, export/import JSON, threshold slider, detection range, show «?» for unknown faces, perf overlay.
- **Fully on-device and offline-capable:** all JS, WASM and models are self-hosted. A service worker caches everything. No network calls with face data, ever.

## How to open
Open the HTTPS URL in Safari (iOS 16.4+) or Chrome (Android), tap «📷 Άνοιγμα κάμερας», allow the camera. 🔄 switches front/back camera. The round shutter at the bottom centre saves a screenshot (camera frame + 3D names/objects + bubbles) via the share sheet on mobile, or as a `noera-YYYYMMDD-HHMMSS.png` download. Optionally add to the home screen.
Self-hosting: any static HTTPS host works (GitHub Pages, Netlify, Cloudflare Pages…). `serve.py` is a local server that sends COOP/COEP headers. On hosts that can't send them, the service worker adds them after the first load (one automatic reload), which enables multi-threaded WASM. Camera needs HTTPS (or localhost).

## Pipeline (why it's fast)
1. **Detection (every frame):** YuNet (OpenCV Zoo, 230 KB) on a 512-px-long-side copy of the frame, run in onnxruntime-web WASM SIMD (multi-threaded when cross-origin isolated). It finds many faces at once, including small/far and turned faces, and gives 5 landmarks.
2. **Tracking:** greedy IoU tracker. An identity sticks to its track, so once recognised a person keeps their label while turning away.
3. **Recognition (only when needed):** SFace (OpenCV Zoo, 128-d) on a 112×112 crop aligned to the ArcFace 5-point template. It runs only for new or unknown tracks (every 2 frames at first, then every 8) and re-verifies known faces every 12 frames, with at most one embedding per frame. Matching is cosine similarity against all stored captures (max per person), with a threshold (default 0.40), a margin to the 2nd-best person (0.05) and EMA over frames. A strong single match labels instantly. Otherwise 2 agreeing frames are needed. Labels are dropped only on a clear near-frontal mismatch.
4. **Rendering:** three.js TextGeometry (DejaVu Sans Bold, Latin and Greek subset), orthographic overlay. Head pose (yaw/pitch/roll) is estimated from the 5 landmarks.

## Models & licences
| Component | Licence | Size |
|---|---|---|
| YuNet face detector 2023mar (OpenCV Zoo), made input-size-dynamic | MIT | 0.23 MB |
| SFace face recognition 2021dec (OpenCV Zoo), weights stored fp16 → fp32 at load | Apache-2.0 | 19.4 MB |
| onnxruntime-web 1.30 (WASM SIMD threaded) | MIT | 14.2 MB wasm |
| three.js r186 | MIT | 2.1 MB |
| DejaVu Sans Bold (Greek+Latin subset → typeface JSON) | Bitstream Vera / public domain (free) | 0.1 MB |
Licence texts: `licenses/`. Model conversion: `tools/prepare_models.py`.
(The prototype first used MediaPipe FaceLandmarker. It was dropped because its short-range detector missed every face narrower than ~12% of the frame, so group shots failed.)

## Honest limits
- Near-profile (>~60° yaw) faces are detected but usually **not recognised** from scratch. A label that was already assigned persists through the turn. Recognition is solid to roughly ±45°.
- Masks, sunglasses, low light, motion blur, tiny/far faces (<~40 px wide) degrade or fail.
- False positives happen (relatives, look-alikes). Tune the threshold: higher means fewer mistakes, lower means easier recognition.
- Not a security or identification tool.
- Head-pose for the label tilt is a 5-point approximation (not a full 3D mesh).

## Privacy
Only enrol people who agree. Data never leaves the device. The export file contains face embeddings, so keep it private.

## Tests
`test/e2e.mjs` runs headless Chrome with a fake camera (Y4M files built from public-domain/CC Wikimedia portraits; not included, see the script header). It checks model loading, guided and one-shot enrollment into IndexedDB, same-feed recognition, and a multi-face scene with known, unknown and side-turned faces. It writes screenshots and `report.json`. `test/bench.html` is a model micro-benchmark.

### Measured (headless Chrome, 8-core box, software GPU — a phone will differ)
- Model load (localhost): 0.5–0.9 s. Each video frame is copied once into a CPU canvas that both models read.
- Micro-benchmark (4 threads / 1 thread): SFace 15 ms / 50 ms per face; YuNet 512×288 5.5 ms / 15.5 ms.
- Full multi-face loop with 4 faces: ~16–20 processed fps. Embedding median 17 ms; label render <1 ms.
- Headless Chrome sometimes throttles the whole page to 2 rAF/s; plain requestAnimationFrame is affected too, so this is not the app. `report.json` comes from such a run and shows ~2 fps. `report_unthrottled_run.json` shows a normal run.
- Real-phone fps is **not yet measured**. Turn on "Στατιστικά" in settings to see live numbers.

## GitHub Pages
This folder is ready for GitHub Pages (e.g. https://<user>.github.io/ar-names/). Pages cannot send COOP/COEP headers,
so `coi-serviceworker.js` (MIT, loaded first in index.html) registers `sw.js`, which adds the headers to every response
and reloads the page once on the first visit; after that the page is `crossOriginIsolated` and onnxruntime uses
multiple threads. `sw.js` also keeps the offline cache. `.nojekyll` disables Jekyll processing; `_headers` is only used by Netlify.
