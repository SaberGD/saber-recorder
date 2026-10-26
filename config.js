// إعدادات الإكستنشن (شوف README.md).
export const CONFIG = {
  // السيستم: صفحة ربط الإكستنشن بحساب المدرب (التطبيق بيستخدم HashRouter، علشان كده فيه #)
  SYSTEM_ORIGIN: 'https://training.sabergroupacademy.com',
  LINK_PAGE_URL: 'https://training.sabergroupacademy.com/#/recorder-link',

  // الـ backend (Cloud Function) اللي بيفتح جلسات الرفع على Drive الأكاديمية
  RECORDER_API: 'https://us-central1-sg-tms-v2.cloudfunctions.net/recorder',

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
  lecture: null, // { groupId, sessionId, courseName, batchCode, groupName, sessionNumber, sessionDate }
};
