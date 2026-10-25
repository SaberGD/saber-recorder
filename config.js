// إعدادات الإكستنشن. الحاجة الوحيدة اللي لازم تتغير هي OAUTH_CLIENT_ID (شوف README.md).
export const CONFIG = {
  // Client ID من نوع "Web application" في Google Cloud Console،
  // ومضاف عليه Redirect URI: https://koaoinnnobkcaabcgnhiajnolamnceoi.chromiumapp.org/
  OAUTH_CLIENT_ID: '',

  // الفولدر اللي هيتعمل على Google Drive الشخصي للمدرب لو مااختارش فولدر الأكاديمية
  DRIVE_FOLDER_NAME: 'Saber Group - تسجيلات المحاضرات',

  // فولدر الأكاديمية المشترك (من رابطه: drive.google.com/drive/folders/<ID>).
  // ده بيفتح الـ Picker على الفولدر على طول بس، ومبيديش أي صلاحية لوحده: المدرب لازم يختاره بنفسه.
  SHARED_FOLDER_ID: '',

  // صفحة اختيار الفولدر على السيستم (التطبيق بيستخدم HashRouter، علشان كده فيه #)
  PICKER_PAGE_URL: 'https://training.sabergroupacademy.com/#/drive-picker',

  // الفولدر جوه Downloads اللي بيتحفظ فيه التسجيل محليًا
  LOCAL_FOLDER_NAME: 'Saber Recordings',

  // حجم كل قطعة رفع على Drive (لازم يكون من مضاعفات 256 KB)
  UPLOAD_CHUNK_BYTES: 8 * 1024 * 1024,

  // كل قد إيه المسجّل يكتب قطعة على الجهاز (ملي ثانية)
  TIMESLICE_MS: 2000,
};

// الجودة: أرقام الحجم تقريبية. شرح الكلاس غالبًا شاشة ثابتة وكلام،
// فـ 15 فريم كفاية وبيوفّر مساحة كبيرة (زي ما زووم بيعمل في مشاركة الشاشة).
export const QUALITY_PRESETS = {
  saver: {
    label: 'موفّر',
    hint: '≈ 300 ميجا / ساعة • 720p',
    width: 1280, height: 720, fps: 10,
    videoBitsPerSecond: 550_000, audioBitsPerSecond: 64_000,
  },
  balanced: {
    label: 'متوازن (زي زووم)',
    hint: '≈ 500 ميجا / ساعة • 1080p',
    width: 1920, height: 1080, fps: 15,
    videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 96_000,
  },
  high: {
    label: 'عالي',
    hint: '≈ 1 جيجا / ساعة • 1080p حركة ناعمة',
    width: 1920, height: 1080, fps: 30,
    videoBitsPerSecond: 2_100_000, audioBitsPerSecond: 128_000,
  },
};

export const DEFAULT_OPTIONS = {
  title: '',
  sources: { screen: true, systemAudio: true, mic: true },
  save: { local: true, drive: true },
  quality: 'balanced',
  micDeviceId: '',
};
