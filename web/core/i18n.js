// @ts-check
// Pure localisation & bidirectional (RTL/LTR) text core (Issue #38).
// Zero browser globals (no navigator, document, Intl, etc.).

/** @type {readonly string[]} */
export const SUPPORTED_LOCALES = Object.freeze(["en", "es", "ar", "ja"]);

/** @type {ReadonlySet<string>} */
export const RTL_LOCALES = new Set(["ar", "he", "fa", "ur"]);

/**
 * Extract the normalized primary language subtag from a BCP-47 locale tag.
 * Example: `"ar-SA"` -> `"ar"`, `"es_MX"` -> `"es"`.
 * @param {string | null | undefined} locale
 * @returns {string}
 */
function primarySubtag(locale) {
  if (typeof locale !== "string") return "";
  const cleaned = locale.trim().replace(/_/g, "-").toLowerCase();
  if (!cleaned) return "";
  return cleaned.split("-")[0];
}

/**
 * Return true if the locale uses right-to-left script direction.
 * @param {string | null | undefined} locale
 * @returns {boolean}
 */
export function isRtlLocale(locale) {
  return RTL_LOCALES.has(primarySubtag(locale));
}

/**
 * Return the HTML `dir` attribute value (`"rtl"` or `"ltr"`) for a locale.
 * @param {string | null | undefined} locale
 * @returns {"rtl" | "ltr"}
 */
export function textDirection(locale) {
  return isRtlLocale(locale) ? "rtl" : "ltr";
}

/**
 * Resolve a preferred BCP-47 locale tag (or ordered list of tags) against a list of supported locales.
 * Handles regional tags such as `"es-MX"` -> `"es"`, `"ar-SA"` -> `"ar"`, `"ja-JP"` -> `"ja"`.
 * Falls back to `"en"` (or the first supported locale if `"en"` is not listed).
 * @param {string | readonly string[] | null | undefined} preferred
 * @param {readonly string[]} [supported]
 * @returns {string}
 */
export function resolveLocale(preferred, supported = SUPPORTED_LOCALES) {
  const list = Array.isArray(supported) && supported.length > 0 ? supported : SUPPORTED_LOCALES;
  /** @type {Map<string, string>} */
  const exactMap = new Map();
  /** @type {Map<string, string>} */
  const baseMap = new Map();

  for (const tag of list) {
    if (typeof tag !== "string") continue;
    const norm = tag.trim().replace(/_/g, "-").toLowerCase();
    if (!norm) continue;
    if (!exactMap.has(norm)) exactMap.set(norm, tag);
    const base = norm.split("-")[0];
    if (!baseMap.has(base)) baseMap.set(base, tag);
  }

  const candidates = Array.isArray(preferred)
    ? preferred
    : typeof preferred === "string"
      ? [preferred]
      : [];

  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const norm = raw.trim().replace(/_/g, "-").toLowerCase();
    if (!norm) continue;
    if (exactMap.has(norm)) return /** @type {string} */ (exactMap.get(norm));
    const base = norm.split("-")[0];
    if (baseMap.has(base)) return /** @type {string} */ (baseMap.get(base));
  }

  return exactMap.get("en") ?? baseMap.get("en") ?? list[0] ?? "en";
}

/**
 * Complete core UI message catalog for `en`, `es`, `ar`, and `ja`.
 * @type {Record<string, Record<string, string>>}
 */
export const MESSAGES = Object.freeze({
  en: Object.freeze({
    // Topbar modes & chrome
    "mode.present": "Present",
    "mode.annotate": "Annotate",
    "mode.view": "View",
    "topbar.boardName": "Board",
    "topbar.themeLight": "Switch to light theme",
    "topbar.themeDark": "Switch to dark theme",
    "topbar.settings": "Settings",
    "topbar.help": "Keyboard shortcuts",
    "topbar.menu": "Menu",

    // Tools
    "tool.select": "Select",
    "tool.hand": "Hand",
    "tool.rectangle": "Rectangle",
    "tool.ellipse": "Ellipse",
    "tool.diamond": "Diamond",
    "tool.arrow": "Arrow",
    "tool.line": "Line",
    "tool.freedraw": "Draw",
    "tool.text": "Text",
    "tool.eraser": "Eraser",
    "tool.frame": "Frame",
    "tool.image": "Image",
    "tool.note": "Sticky note",
    "tool.highlighter": "Highlighter",

    // Dialogs
    "dialog.close": "Close",
    "dialog.cancel": "Cancel",
    "dialog.confirm": "Confirm",
    "dialog.save": "Save",
    "dialog.delete": "Delete",
    "dialog.export": "Export",
    "dialog.import": "Import",
    "dialog.shortcuts": "Keyboard shortcuts",

    // Share
    "share.title": "Share board",
    "share.copyLink": "Copy link",
    "share.copied": "Link copied",
    "share.roleOwner": "Owner",
    "share.roleEditor": "Editor",
    "share.roleAnnotator": "Annotator",
    "share.roleViewer": "Viewer",
    "share.invite": "Invite collaborators",

    // Comments
    "comments.title": "Comments",
    "comments.placeholder": "Add a comment…",
    "comments.post": "Post",
    "comments.reply": "Reply",
    "comments.resolve": "Resolve",
    "comments.reopen": "Reopen",
    "comments.empty": "No comments yet",
    "comments.count": "{count} comments",

    // Replay & timeline
    "replay.title": "Replay",
    "replay.play": "Play",
    "replay.pause": "Pause",
    "replay.stepBack": "Step backward",
    "replay.stepForward": "Step forward",
    "replay.live": "Return to live",
    "replay.speed": "{speed}x speed",

    // Offline & connection status
    "status.live": "Live",
    "status.connecting": "Connecting…",
    "status.catchingUp": "Catching up…",
    "status.offline": "Offline",
    "status.offlineBanner": "You are offline. Changes are saved locally until you reconnect.",
    "status.readOnly": "View only",
    "status.pendingEdits": "{count} edits waiting",
    "status.retry": "Retry",
    "status.reload": "Reload",

    // Accessibility skip-link & landmarks
    "a11y.skipToCanvas": "Skip to canvas",
    "a11y.landmarkTopbar": "Top toolbar",
    "a11y.landmarkCanvas": "Interactive whiteboard canvas",
    "a11y.landmarkDrawer": "Navigation drawer",
    "a11y.landmarkPanel": "Properties panel",
    "a11y.landmarkTimeline": "Replay timeline",
    "a11y.landmarkStatus": "Status notifications",
    "a11y.zoomLevel": "Zoom {percent}%",
  }),

  es: Object.freeze({
    // Topbar modes & chrome
    "mode.present": "Presentar",
    "mode.annotate": "Anotar",
    "mode.view": "Ver",
    "topbar.boardName": "Tablero",
    "topbar.themeLight": "Cambiar a tema claro",
    "topbar.themeDark": "Cambiar a tema oscuro",
    "topbar.settings": "Configuración",
    "topbar.help": "Atajos de teclado",
    "topbar.menu": "Menú",

    // Tools
    "tool.select": "Seleccionar",
    "tool.hand": "Mano",
    "tool.rectangle": "Rectángulo",
    "tool.ellipse": "Elipse",
    "tool.diamond": "Rombo",
    "tool.arrow": "Flecha",
    "tool.line": "Línea",
    "tool.freedraw": "Dibujar",
    "tool.text": "Texto",
    "tool.eraser": "Borrador",
    "tool.frame": "Marco",
    "tool.image": "Imagen",
    "tool.note": "Nota adhesiva",
    "tool.highlighter": "Resaltador",

    // Dialogs
    "dialog.close": "Cerrar",
    "dialog.cancel": "Cancelar",
    "dialog.confirm": "Confirmar",
    "dialog.save": "Guardar",
    "dialog.delete": "Eliminar",
    "dialog.export": "Exportar",
    "dialog.import": "Importar",
    "dialog.shortcuts": "Atajos de teclado",

    // Share
    "share.title": "Compartir tablero",
    "share.copyLink": "Copiar enlace",
    "share.copied": "Enlace copiado",
    "share.roleOwner": "Propietario",
    "share.roleEditor": "Editor",
    "share.roleAnnotator": "Anotador",
    "share.roleViewer": "Lector",
    "share.invite": "Invitar colaboradores",

    // Comments
    "comments.title": "Comentarios",
    "comments.placeholder": "Añadir un comentario…",
    "comments.post": "Publicar",
    "comments.reply": "Responder",
    "comments.resolve": "Resolver",
    "comments.reopen": "Reabrir",
    "comments.empty": "Aún no hay comentarios",
    "comments.count": "{count} comentarios",

    // Replay & timeline
    "replay.title": "Repetición",
    "replay.play": "Reproducir",
    "replay.pause": "Pausar",
    "replay.stepBack": "Paso atrás",
    "replay.stepForward": "Paso adelante",
    "replay.live": "Volver en vivo",
    "replay.speed": "Velocidad {speed}x",

    // Offline & connection status
    "status.live": "En vivo",
    "status.connecting": "Conectando…",
    "status.catchingUp": "Sincronizando…",
    "status.offline": "Sin conexión",
    "status.offlineBanner": "Estás sin conexión. Los cambios se guardan localmente hasta reconectar.",
    "status.readOnly": "Solo lectura",
    "status.pendingEdits": "{count} cambios pendientes",
    "status.retry": "Reintentar",
    "status.reload": "Recargar",

    // Accessibility skip-link & landmarks
    "a11y.skipToCanvas": "Saltar al lienzo",
    "a11y.landmarkTopbar": "Barra de herramientas superior",
    "a11y.landmarkCanvas": "Lienzo interactivo",
    "a11y.landmarkDrawer": "Panel de navegación",
    "a11y.landmarkPanel": "Panel de propiedades",
    "a11y.landmarkTimeline": "Línea de tiempo de repetición",
    "a11y.landmarkStatus": "Notificaciones de estado",
    "a11y.zoomLevel": "Zoom {percent}%",
  }),

  ar: Object.freeze({
    // Topbar modes & chrome
    "mode.present": "عرض",
    "mode.annotate": "تعليق توضيحي",
    "mode.view": "مشاهدة",
    "topbar.boardName": "اللوحة",
    "topbar.themeLight": "التبديل إلى المظهر الفاتح",
    "topbar.themeDark": "التبديل إلى المظهر الداكن",
    "topbar.settings": "الإعدادات",
    "topbar.help": "اختصارات لوحة المفاتيح",
    "topbar.menu": "القائمة",

    // Tools
    "tool.select": "تحديد",
    "tool.hand": "تحريك",
    "tool.rectangle": "مستطيل",
    "tool.ellipse": "شكل بيضاوي",
    "tool.diamond": "معين",
    "tool.arrow": "سهم",
    "tool.line": "خط",
    "tool.freedraw": "رسم حر",
    "tool.text": "نص",
    "tool.eraser": "ممحاة",
    "tool.frame": "إطار",
    "tool.image": "صورة",
    "tool.note": "ملاحظة لاصقة",
    "tool.highlighter": "قلم تمييز",

    // Dialogs
    "dialog.close": "إغلاق",
    "dialog.cancel": "إلغاء",
    "dialog.confirm": "تأكيد",
    "dialog.save": "حفظ",
    "dialog.delete": "حذف",
    "dialog.export": "تصدير",
    "dialog.import": "استيراد",
    "dialog.shortcuts": "اختصارات لوحة المفاتيح",

    // Share
    "share.title": "مشاركة اللوحة",
    "share.copyLink": "نسخ الرابط",
    "share.copied": "تم نسخ الرابط",
    "share.roleOwner": "المالك",
    "share.roleEditor": "محرر",
    "share.roleAnnotator": "معلّق توضيحي",
    "share.roleViewer": "مشاهد",
    "share.invite": "دعوة متعاونين",

    // Comments
    "comments.title": "التعليقات",
    "comments.placeholder": "أضف تعليقاً…",
    "comments.post": "نشر",
    "comments.reply": "رد",
    "comments.resolve": "تم الحل",
    "comments.reopen": "إعادة فتح",
    "comments.empty": "لا توجد تعليقات بعد",
    "comments.count": "{count} تعليقات",

    // Replay & timeline
    "replay.title": "إعادة التشغيل",
    "replay.play": "تشغيل",
    "replay.pause": "إيقاف مؤقت",
    "replay.stepBack": "خطوة للخلف",
    "replay.stepForward": "خطوة للأمام",
    "replay.live": "العودة إلى البث المباشر",
    "replay.speed": "سرعة {speed}x",

    // Offline & connection status
    "status.live": "مباشر",
    "status.connecting": "جارٍ الاتصال…",
    "status.catchingUp": "جارٍ المزامنة…",
    "status.offline": "غير متصل",
    "status.offlineBanner": "أنت غير متصل بالإنترنت. تُحفظ التغييرات محلياً حتى إعادة الاتصال.",
    "status.readOnly": "للقراءة فقط",
    "status.pendingEdits": "{count} تعديلات قيد الانتظار",
    "status.retry": "إعادة المحاولة",
    "status.reload": "إعادة التحميل",

    // Accessibility skip-link & landmarks
    "a11y.skipToCanvas": "الانتقال إلى اللوحة",
    "a11y.landmarkTopbar": "شريط الأدوات العلوي",
    "a11y.landmarkCanvas": "لوحة الرسم التفاعلية",
    "a11y.landmarkDrawer": "درج التنقل",
    "a11y.landmarkPanel": "لوحة الخصائص",
    "a11y.landmarkTimeline": "الخط الزمني لإعادة التشغيل",
    "a11y.landmarkStatus": "إشعارات الحالة",
    "a11y.zoomLevel": "التكبير {percent}%",
  }),

  ja: Object.freeze({
    // Topbar modes & chrome
    "mode.present": "プレゼン",
    "mode.annotate": "注釈",
    "mode.view": "閲覧",
    "topbar.boardName": "ボード",
    "topbar.themeLight": "ライトテーマに切り替え",
    "topbar.themeDark": "ダークテーマに切り替え",
    "topbar.settings": "設定",
    "topbar.help": "キーボードショートカット",
    "topbar.menu": "メニュー",

    // Tools
    "tool.select": "選択",
    "tool.hand": "手のひら",
    "tool.rectangle": "長方形",
    "tool.ellipse": "楕円",
    "tool.diamond": "ひし形",
    "tool.arrow": "矢印",
    "tool.line": "直線",
    "tool.freedraw": "フリーハンド",
    "tool.text": "テキスト",
    "tool.eraser": "消しゴム",
    "tool.frame": "フレーム",
    "tool.image": "画像",
    "tool.note": "付箋",
    "tool.highlighter": "蛍光ペン",

    // Dialogs
    "dialog.close": "閉じる",
    "dialog.cancel": "キャンセル",
    "dialog.confirm": "確認",
    "dialog.save": "保存",
    "dialog.delete": "削除",
    "dialog.export": "エクスポート",
    "dialog.import": "インポート",
    "dialog.shortcuts": "キーボードショートカット",

    // Share
    "share.title": "ボードを共有",
    "share.copyLink": "リンクをコピー",
    "share.copied": "リンクをコピーしました",
    "share.roleOwner": "オーナー",
    "share.roleEditor": "編集者",
    "share.roleAnnotator": "注釈者",
    "share.roleViewer": "閲覧者",
    "share.invite": "共同編集者を招待",

    // Comments
    "comments.title": "コメント",
    "comments.placeholder": "コメントを追加…",
    "comments.post": "投稿",
    "comments.reply": "返信",
    "comments.resolve": "解決",
    "comments.reopen": "再開",
    "comments.empty": "コメントはまだありません",
    "comments.count": "{count}件のコメント",

    // Replay & timeline
    "replay.title": "リプレイ",
    "replay.play": "再生",
    "replay.pause": "一時停止",
    "replay.stepBack": "1つ戻る",
    "replay.stepForward": "1つ進む",
    "replay.live": "ライブに戻る",
    "replay.speed": "{speed}倍速",

    // Offline & connection status
    "status.live": "ライブ",
    "status.connecting": "接続中…",
    "status.catchingUp": "同期中…",
    "status.offline": "オフライン",
    "status.offlineBanner": "オフラインです。再接続されるまで変更はローカルに保存されます。",
    "status.readOnly": "閲覧のみ",
    "status.pendingEdits": "{count}件の未送信の変更",
    "status.retry": "再試行",
    "status.reload": "再読み込み",

    // Accessibility skip-link & landmarks
    "a11y.skipToCanvas": "キャンバスへスキップ",
    "a11y.landmarkTopbar": "上部ツールバー",
    "a11y.landmarkCanvas": "インタラクティブホワイトボード",
    "a11y.landmarkDrawer": "ナビゲーションドロワー",
    "a11y.landmarkPanel": "プロパティパネル",
    "a11y.landmarkTimeline": "リプレイタイムライン",
    "a11y.landmarkStatus": "ステータス通知",
    "a11y.zoomLevel": "ズーム {percent}%",
  }),
});

/**
 * Translate a UI message key for the given locale with `{name}` interpolation.
 * Lookup order: resolved locale catalog -> English (`en`) catalog -> raw `key`.
 * @param {string} key
 * @param {Record<string, string | number | boolean> | null | undefined} [vars]
 * @param {string | null | undefined} [locale]
 * @returns {string}
 */
export function t(key, vars = {}, locale = "en") {
  const resolved = resolveLocale(locale, SUPPORTED_LOCALES);
  const catalog = MESSAGES[resolved] ?? MESSAGES.en;
  const template =
    (catalog && Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : undefined) ??
    (Object.prototype.hasOwnProperty.call(MESSAGES.en, key) ? MESSAGES.en[key] : undefined) ??
    String(key);

  if (!vars || typeof vars !== "object") return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return match;
    const val = vars[name];
    return val === undefined || val === null ? match : String(val);
  });
}
