// sw.js — Service Worker לאתר הסטטי של סיוון (דשבורד + פורטל הלקוחה).
// כתוב בכוונה בסגנון ES5-ish, בלי import/export ובלי תלות בשום ספרייה חיצונית,
// כדי שיעבוד בכל דפדפן תומך Service Worker בלי צעד build נפרד.
//
// סקירה יריבותית 23.8.2026 — ארבעה ליקויים תוקנו כאן (ולכן שם המטמון עלה ל-v2):
//   1. הרענון-ברקע לא הוחזק ב-event.waitUntil. ברגע שהתגובה מהמטמון נשלחת הדפדפן
//      רשאי להרוג את ה-worker — כלומר cache.put לא הספיק להיכתב, והלקוחה נשארה
//      תקועה על גרסה ישנה גם אחרי עשרים כניסות.
//   2. ניווטים (ה-HTML) הוגשו stale-while-revalidate. ה-HTML *הוא* כל האפליקציה
//      כאן, אז אחרי כל פריסה הלקוחה קיבלה מסך ישן; עכשיו הם network-first
//      והמטמון הוא רק רשת הביטחון לאופליין.
//   3. מפתח המטמון היה הכתובת המלאה כולל query. קישור-הכניסה למייל מגיע עם
//      ?ct=<טוקן> ועם פרמטרים ש-Firebase מוסיף — כל אחד יצר עותק נפרד במטמון.
//   4. ה-fallback לאופליין החזיר תמיד קודם את client.html — גם לניווט לדשבורד.

var CACHE = "sivan-static-v2";

// סיומות/נתיבים שמותר למטמון (cache) לגעת בהם. שומרים את הרשימה סגורה בכוונה —
// כל דבר שלא ברשימה (כמו קריאות API) פשוט לא נוגעים בו ונותנים לרשת לטפל.
var CACHEABLE_EXT = [".html", ".js", ".webmanifest", ".png", ".svg", ".css"];

self.addEventListener("install", function (event) {
  // skipWaiting: לא רוצים שגרסה ישנה של ה-SW תמשיך לשרת דפים אחרי שפרסמנו
  // עדכון — האתר קטן וסטטי, אז "לקפוץ" לגרסה החדשה מיד הוא הבחירה הבטוחה יותר
  // מלהמתין שכל הטאבים הפתוחים ייסגרו.
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names
          .filter(function (name) {
            // מוחקים רק מטמונים ישנים של האתר הזה (התחלה ב-"sivan-static-")
            // ולא CACHE הנוכחי — כדי לא לגעת במטמונים של גרסאות עתידיות/אחרות
            // בטעות, ולפנות מקום מגרסאות שעברו.
            return name.indexOf("sivan-static-") === 0 && name !== CACHE;
          })
          .map(function (name) {
            return caches.delete(name);
          })
      );
    }).then(function () {
      // clients.claim: כדי שטאבים שכבר פתוחים יתחילו להיות מוגשים ע"י ה-SW
      // החדש מיד, בלי לחכות לרענון נוסף.
      return self.clients.claim();
    })
  );
});

function isCacheableRequest(req) {
  if (req.method !== "GET") return false;

  var url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return false;
  }

  // רק same-origin — אף פעם לא נוגעים בבקשות חוצות-מקור (Firestore/Google APIs/
  // גופנים/Firebase Auth) כדי לא לשבור אימות, קריאות בזמן-אמת או מדיניות CORS.
  if (url.origin !== self.location.origin) return false;

  // __/auth הוא הנתיב שבו Firebase Hosting/Auth מטפל בהפניות אימות (OAuth וכו') —
  // אסור לתפוס אותו ב-cache, הוא חייב תמיד לרשת/לוגיקה של Firebase.
  if (url.pathname.indexOf("__/auth") !== -1) return false;

  // בקשת ניווט (טעינת עמוד HTML ע"י הדפדפן) — תמיד מותר, גם בלי סיומת בנתיב.
  if (req.mode === "navigate") return true;

  // שורש ה-scope או נתיב-תיקייה (מסתיים ב-"/") — נחשב כמו ניווט.
  if (url.pathname === self.registration.scope.replace(self.location.origin, "") || /\/$/.test(url.pathname)) {
    return true;
  }

  for (var i = 0; i < CACHEABLE_EXT.length; i++) {
    if (url.pathname.slice(-CACHEABLE_EXT[i].length) === CACHEABLE_EXT[i]) return true;
  }

  return false;
}

function isGoodResponse(res) {
  // לא ממטמנים תגובות שגיאה (סטטוס לא 200) ולא תגובות "אטומות" (opaque —
  // תוצאה של no-cors לבקשה חוצה-מקור; אין לנו דרך לדעת אם הן הצליחו, ואם
  // נשמור אותן בטעות לתמיד לא נדע להחליף אותן).
  return res && res.status === 200 && res.type !== "opaque";
}

// כל עבודה שממשיכה אחרי שהתגובה כבר נשלחה (רענון ברקע, כתיבה למטמון) חייבת
// לעבור דרך event.waitUntil — אחרת הדפדפן רשאי להרוג את ה-worker באמצע והמטמון
// לא מתעדכן לעולם (הליקוי הראשון בסקירה היריבותית של 23.8.2026). ה-catch הוא
// כדי שכישלון רשת/מכסת-אחסון לא ידווח כשגיאה לא-מטופלת ולא יפיל את התגובה.
function keepAlive(event, promise) {
  var p = promise.catch(function () {});
  try { event.waitUntil(p); } catch (e) {}
  return p;
}

// מפתח מטמון מנורמל — אותה כתובת בלי ה-query. הדף קורא את location.search בזמן
// ריצה (?ct=<טוקן> של קישור-המייל, פרמטרים של Firebase), כלומר ה-HTML עצמו זהה
// לכל ה-query-ים: בלי נרמול כל קישור היה נכנס כעותק נפרד, והעותק ה"נקי" — זה
// שכל שאר הכניסות מחפשות — לא היה מתעדכן אף פעם.
function cacheKeyFor(req, url) {
  if (req.mode === "navigate" || /\.html$/.test(url.pathname)) {
    return new Request(url.origin + url.pathname);
  }
  return req;
}

// ניווטים = network-first. ה-HTML הוא כל האפליקציה כאן (דשבורד/פורטל בקובץ אחד),
// ולכן רעננות מנצחת: מביאים מהרשת, ורק כשאין רשת נופלים למטמון ואז ל-fallback.
function networkFirst(event, req, url) {
  var key = cacheKeyFor(req, url);
  return fetch(req).then(function (res) {
    if (isGoodResponse(res)) {
      // את ה-clone עושים כאן, סינכרונית, לפני שהתגובה נמסרת לדפדפן: clone מאוחר יותר
      // (בתוך ה-then של caches.open) עלול ליפול על גוף שהדפדפן כבר התחיל לקרוא.
      var copy = res.clone();
      // נתיב-תיקייה ("/" או "/p/") נשמר גם תחת index.html של אותה תיקייה: הדשבורד
      // המותקן פותח את start_url "./index.html", והכניסה הרגילה היא ל-"/" — בלי
      // הכפילות הזו האפליקציה המותקנת לא מוצאת כלום באופליין.
      var dirCopy = /\/$/.test(url.pathname) ? res.clone() : null;
      keepAlive(event, caches.open(CACHE).then(function (cache) {
        return cache.put(key, copy).catch(function () {});
      }));
      if (dirCopy) {
        keepAlive(event, caches.open(CACHE).then(function (cache) {
          return cache.put(new Request(url.origin + url.pathname + "index.html"), dirCopy).catch(function () {});
        }));
      }
    }
    return res;
  }).catch(function () {
    return caches.open(CACHE).then(function (cache) {
      return cache.match(key).then(function (cached) {
        if (cached) return cached;
        return offlineFallback(req);
      });
    });
  });
}

// stale-while-revalidate: מגישים מיד את מה שיש ב-cache (מהירות/אופליין),
// ובמקביל שולפים גרסה טרייה מהרשת ברקע כדי שהפעם הבאה תהיה מעודכנת.
// זו האסטרטגיה הנכונה לנכסים (js/css/אייקונים/מניפסטים) — הם משתנים לעתים
// רחוקות, וחבל להמתין להם ברשת. את ה-HTML עצמו מטפל networkFirst למעלה.
function staleWhileRevalidate(event, req, url) {
  var key = cacheKeyFor(req, url);
  return caches.open(CACHE).then(function (cache) {
    return cache.match(key).then(function (cached) {
      var networkFetch = fetch(req)
        .then(function (res) {
          if (isGoodResponse(res)) {
            keepAlive(event, cache.put(key, res.clone()).catch(function () {}));
          }
          return res;
        })
        .catch(function () {
          return null;
        });

      if (cached) {
        // יש כבר עותק במטמון — מחזירים אותו מיד, והרשת מתעדכנת ברקע (מוחזק
        // ב-waitUntil כדי שה-worker לא ייהרג לפני שהכתיבה למטמון הסתיימה).
        keepAlive(event, networkFetch);
        return cached;
      }

      // אין עותק במטמון — מחכים לרשת. אם היא נכשלת, יש טיפול נפרד למטה
      // (offline fallback) עבור בקשות ניווט.
      return networkFetch.then(function (res) {
        if (res) return res;
        return offlineFallback(req);
      });
    });
  });
}

function offlineFallback(req) {
  // אין רשת ואין עותק במטמון לבקשה הזו. עבור ניווט (טעינת עמוד) — מחזירים את
  // העמוד הנכון *לפי הנתיב*: לפורטל (client.html או הקיצור /p/) את client.html,
  // ולכל השאר את index.html של הדשבורד. עד 23.8.2026 client.html הוחזר תמיד
  // ראשון, כלומר ניווט לדשבורד באופליין קיבל את מסך הלקוחה. אם גם המטמון ריק —
  // עמוד "אין חיבור" מינימלי בעברית.
  if (req.mode !== "navigate") {
    return new Response("", { status: 503, statusText: "Offline" });
  }

  var p = "";
  try { p = new URL(req.url).pathname; } catch (e) { p = ""; }
  var wantClient = /client\.html$/.test(p) || /\/p\/?$/.test(p);

  return caches.open(CACHE).then(function (cache) {
    return cache.match(wantClient ? "client.html" : "index.html").then(function (hit) {
      if (hit) return hit;

      var html =
        '<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        "<title>אין חיבור</title></head>" +
        '<body style="margin:0;min-height:100vh;display:flex;align-items:center;' +
        'justify-content:center;background:#FAF7F1;color:#35291C;' +
        'font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;' +
        'text-align:center;padding:24px">' +
        "<p>אין חיבור לאינטרנט — נסי שוב בעוד רגע</p>" +
        "</body></html>";

      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    });
  });
}

self.addEventListener("fetch", function (event) {
  var req = event.request;

  if (!isCacheableRequest(req)) {
    // כל השאר (בקשות API, קריאות Firestore/Firebase, מתודות שאינן GET וכו')
    // עוברים ישירות לרשת בלי שום מעורבות של ה-SW — network-only, כי אלה
    // בדרך כלל בקשות דינמיות/מאומתות שאסור להגיש מהמטמון.
    return;
  }

  var url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(networkFirst(event, req, url));
    return;
  }

  event.respondWith(staleWhileRevalidate(event, req, url));
});
