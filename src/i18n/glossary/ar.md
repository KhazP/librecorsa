# LibreCorsa Arabic Glossary (`ar`)

## Style

- **Variety & register:** Modern Standard Arabic (الفصحى الحديثة) tailored for players across the Gulf and Egypt. Clear, idiomatic sim-racing terminology aligned with Arabic editions of *Gran Turismo 7*, *EA Sports F1*, and Arabic motorsport broadcasts.
- **Addressing the player:** Masculine singular imperative for instructions and prompts (e.g. اضغط، اختر، أعد المحاولة), and concise verbal nouns (مصادر) for buttons, menu items, and settings labels (e.g. متابعة، حفظ، إعادة التشغيل، القيادة).
- **HUD brevity:** Keep `hud.` and `hudStyles.` strings as concise as possible. Preserve Latin HUD codes (FL, PB, ELEC, TYRE, L{lap}, T{turn}) where no short Arabic equivalent fits cleanly; never invent Arabic letter abbreviations.
- **Punctuation:** Use Arabic punctuation (`،` `؛` `؟`) with standard `.` and `:`. Never use the ASCII apostrophe `'`.
- **Preserved Latin terms:** Keep car names, circuit names, driver names, LibreCorsa, DRS, ERS, ABS, TC, MFD, HUD, FFB, km/h, mph, rpm, S1/S2/S3, P1/P2, keyboard keys (Esc, Shift, Enter, Space, F8, WASD, Ctrl+V), and controller buttons (Cross, Circle, A, B, L3, R2, LB…) in Latin.
- **Plurals:** Every ICU plural includes all six Arabic CLDR categories (`zero` or `=0`, `one`, `two`, `few`, `many`, `other`) with proper Arabic grammar (singular for 1, dual for 2, plural genitive for 3–10, singular accusative for 11–99, singular genitive for 100+).

## Terms

| English | Arabic | Note |
|---|---|---|
| Drive | القيادة | Main menu action to start driving |
| lap | لفة | pl. لفات |
| lap time | زمن اللفة | |
| best lap | أفضل لفة | |
| fastest lap | أسرع لفة | |
| personal best | أفضل زمن شخصي | Short HUD: PB or أفضل شخصي |
| last lap | اللفة الأخيرة | |
| final lap | اللفة الأخيرة | HUD قصير (Blade): آخر لفة |
| out lap | لفة الخروج | |
| optimal lap | المثالية | Short HUD label for theoretical best lap |
| predicted lap | المتوقع / متوقع | Short HUD: المتوقع or متوقع |
| on a PB | نحو PB | Short HUD tag for personal-best pace |
| reference lap | اللفة المرجعية | indef. لفة مرجعية |
| compared lap | اللفة المقارَنة | |
| lap comparison | مقارنة اللفات | |
| sector | قطاع | pl. قطاعات |
| lap board | لوحة الأزمنة | Online leaderboard of lap times |
| Hall of Fame | قاعة المشاهير | All-time lap records |
| GOAT (badge) | الأعظم | شارة صدارة قائمة الأكثر تتويجًا؛ الاسم والوسم القصير معًا |
| weekly challenge | التحدي الأسبوعي | |
| time trial | تجربة الزمن | |
| practice | تدريب | Free practice: تدريب حر |
| race | سباق | |
| AI race | سباق ضد الذكاء الاصطناعي | Short: سباق AI |
| grid | شبكة الانطلاق | Short: الشبكة |
| pole position | مركز الانطلاق الأول | |
| pit lane | حارة الصيانة | |
| pit limiter | محدد سرعة الصيانة | |
| limiter | المحدد | Speed limiter; Limiter on: المحدد مفعّل |
| track limits | حدود الحلبة | |
| lap deleted | أُلغيت اللفة | Short badge: لفة ملغاة |
| racing line | خط السباق | Drawn ideal line |
| driving line | مسار القيادة | Line the car drove, distinct from خط السباق |
| braking point | نقطة الكبح | |
| apex | قمة المنعطف | |
| kerb | رصيف الحلبة | pl. أرصفة |
| run-off | منطقة الأمان | Run-off area outside the track |
| circuit | حلبة | pl. حلبات |
| layout | المسار | Circuit configuration (تخطيط المسار) |
| hill climb | تسلق الهضاب | |
| point-to-point | من نقطة إلى نقطة | |
| car | سيارة | pl. سيارات |
| class | فئة | Car class; pl. فئات |
| livery | الطلاء | indef. طلاء، pl. طلاءات |
| ghost | الشبح | Recorded translucent lap car (سيارة الشبح) |
| ghost mode | وضع الشبح | Multiplayer no-contact mode |
| share code | رمز المشاركة | |
| room / room code / host / join | غرفة / رمز الغرفة / المضيف (استضافة) / انضمام | Online multiplayer room |
| lobby | الغرفة | Same word as room |
| driver | سائق | pl. سائقون / سائقين |
| force feedback | رد الفعل القسري | Keep FFB when abbreviated |
| steering wheel / wheel | عجلة القيادة / المقود | Use المقود in short UI/HUD |
| pedals | الدواسات | sg. دواسة |
| throttle | دواسة التسارع / التسارع | Distinct from fuel (الوقود) |
| brake | المكابح | Verb: الكبح؛ pedal: دواسة المكابح |
| clutch | القابض | |
| handbrake | مكبح اليد | |
| gear up / gear down | رفع الترس / خفض الترس | |
| paddle shifters | عتلات التبديل | |
| manual gearbox / automatic gearbox | ناقل حركة يدوي / ناقل حركة أوتوماتيكي | |
| dead zone | المنطقة الميتة | |
| steering lock / full lock | أقصى زاوية توجيه / توجيه كامل | |
| steering rotation | دوران المقود | Degrees of wheel rotation |
| sensitivity | الحساسية | |
| linearity | الخطية | |
| gyro steering | التوجيه بالجيروسكوب | |
| controller | وحدة التحكم | Gamepad |
| keyboard | لوحة المفاتيح | |
| touch controls | التحكم باللمس | |
| bind | تعيين | Assign a button or axis |
| unbind | إلغاء تعيين | Remove a button or key binding |
| axis | محور | pl. محاور |
| calibrate | معايرة | |
| driving assists | مساعدات القيادة | |
| traction control | التحكم بالجر | Keep TC when abbreviated |
| TC slip angle | زاوية انزلاق TC | |
| ABS | ABS | Explain as مانع انغلاق المكابح if needed |
| stability control | التحكم بالثبات | |
| brake bias | توزيع المكابح | |
| brake migration | انتقال توازن المكابح | Short HUD: انتقال التوازن |
| tyre wear | تآكل الإطارات | |
| tread | النقشة | Tread left: النقشة المتبقية؛ tyre surface widget uses سطح الإطار |
| flat / puncture | مثقوب / ثقب | Short HUD tag: مثقوب (flat/punctured), ثقب (puncture) |
| tyre temperatures | حرارة الإطارات | |
| tyre pressure | ضغط الإطارات | |
| tyre compound: soft, medium, hard, intermediate, wet | مركّب الإطارات: ناعم، متوسط، صلب، وسيط، مبلل | Intermediate = وسيط (مطر خفيف) |
| super soft | فائق النعومة | Compound; إطارات فائقة النعومة (أنعم من الناعم) |
| tyre blankets | بطانيات الإطارات | بطانيات تسخين الإطارات when expanded |
| setup | إعداد السيارة | Short: الإعداد (distinct from الإعدادات = Settings) |
| apply setup | تطبيق الإعداد | |
| suspension | نظام التعليق | Short: التعليق |
| ride height | ارتفاع الهيكل | |
| springs | النوابض | |
| dampers | المخمدات | |
| bump / rebound (fast bump, slow rebound) | الانضغاط / الارتداد (انضغاط سريع، ارتداد بطيء) | |
| bumpstop | المصدّ | Tooltip bump rubber: المصد المطاطي |
| bumpstop travel | شوط المصدّ | |
| anti-roll bar | قضيب التوازن | |
| camber | زاوية الميلان | |
| toe | زاوية التقارب | |
| downforce | القوة السفلية | |
| rear wing / front wing | الجناح الخلفي / الجناح الأمامي | |
| active aero | الانسيابية النشطة | |
| drag | السحب الهوائي | Short: السحب |
| aero balance | التوازن الهوائي | Short HUD: توازن |
| grip / front grip / rear grip | التماسك / التماسك الأمامي / التماسك الخلفي | |
| slip | الانزلاق | Telemetry legend |
| understeer / oversteer | قصور التوجيه / فرط التوجيه | |
| differential | الترس التفاضلي | Short: التفاضلي |
| diff lock | قفل التفاضلي | Short telemetry label: قفل LSD |
| gear ratios | نسب التروس | |
| fuel | الوقود | Distinct from throttle (التسارع) |
| fuel margin: spare / short | فائض / نقص | |
| yellow flag / double yellow / blue flag / black flag / chequered flag / green flag | علم أصفر / علم أصفر مزدوج / علم أزرق / علم أسود / علم الشطرنج / علم أخضر | |
| double yellow (short) | أصفر مزدوج | Short HUD tag |
| blue flag (short) | أزرق | Short HUD tag |
| safety car | سيارة الأمان | |
| VSC ending | انتهاء VSC | |
| penalty / time penalty / drive-through | عقوبة / عقوبة زمنية / المرور بحارة الصيانة | |
| retired | انسحب | Status in results; start lights: انسحاب؛ DNF stays in Latin |
| disqualified | مستبعد | DSQ stays in Latin |
| damage: minor / heavy | طفيف / كبير | |
| lights out | انطفاء الأضواء | Race start |
| jump start | انطلاق مبكر | |
| formation | التشكيل | Rolling start |
| overtake (verb) / overtake mode | تجاوز / وضع التجاوز | F1 2026 energy boost |
| ERS / DRS / deploy / harvest | ERS / DRS / إطلاق الطاقة / استعادة الطاقة | Keep ERS and DRS in Latin |
| MGU-K | MGU-K | Keep in Latin |
| regeneration / regen | استعادة الطاقة / استعادة | Short HUD: استعادة |
| battery | البطارية | |
| HUD | HUD | Keep in Latin |
| Blade | النصل | HUD layout name |
| Trackside | جانب الحلبة | HUD layout name |
| Pit wall | جدار الصيانة | HUD layout name |
| Endurance | التحمّل | HUD layout name |
| Racing line | خط السباق | HUD layout name |
| proximity radar | رادار القرب | |
| spotter | المراقب الصوتي | Short HUD and compounds: المراقب |
| team radio / radio sound | راديو الفريق / صوت الراديو | |
| shift lights / rev lights | أضواء تبديل التروس | |
| delta | الفارق الزمني | Short HUD: الفارق or دلتا |
| gap | الفارق | Time gap to car ahead/behind |
| interval | الفاصل | Full and short HUD |
| gap to leader | الفارق عن المتصدر | Short: عن المتصدر |
| relative | النسبي | Cars ahead/behind on track |
| position | المركز | |
| mirror | المرآة | |
| camera: chase camera, cockpit, bonnet camera, Trackside TV, free camera | الكاميرا: كاميرا الملاحقة، قمرة القيادة، كاميرا غطاء المحرك، البث التلفزيوني، كاميرا حرة | |
| replay | إعادة العرض | Short: الإعادة |
| pause menu / main menu | قائمة الإيقاف المؤقت / القائمة الرئيسية | |
| restart / retry / quit / continue | إعادة التشغيل / إعادة المحاولة / خروج / متابعة | |
| Settings / Display / Audio / Controls / Graphics / Gameplay | الإعدادات / العرض / الصوت / التحكم / الرسوميات / أسلوب اللعب | |
| quality: Low, Medium, High, Ultra | الجودة: منخفضة، متوسطة، عالية، فائقة | |
| frame rate | معدل الإطارات | |
| resolution | الدقة | |
| Reset / Restore default | إعادة تعيين / استعادة الافتراضي | |
| weather: clear, cloudy, overcast, rain, wet track, dry track | الطقس: صافٍ، غائم، ملبد بالغيوم، مطر، مسار مبلل، مسار جاف | |
| time of day / night | وقت اليوم / ليل | |
| realism (Full realism) | الواقعية (الواقعية الكاملة) | |
| physics / physics version | الفيزياء / إصدار الفيزياء | |
| post / upload | نشر / رفع | Post a lap to the board / upload |
| Lap times | أزمنة اللفات | Screen listing lap times |
| mod | مود | pl. مودات؛ badge: مود |
| mod package | حزمة مود | pl. حزم المودات |
| mods folder | مجلد المودات | |
| import folder | مجلد الاستيراد | Noun; action button Import folder: استيراد مجلد |
| converter | المحوّل | Mod converter |
| converter log | سجل المحوّل | |
| fingerprint | بصمة | SHA-256 checksum |
| launcher | المشغّل | |
| offline launcher | المشغّل غير المتصل | |
| desktop app | تطبيق سطح المكتب | |
| licence | الترخيص | indef. ترخيص، pl. تراخيص |
| "More info" (Windows SmartScreen) | مزيد من المعلومات | Quote Windows Arabic wording |
| "Run anyway" (Windows SmartScreen) | التشغيل على أي حال | Quote Windows Arabic wording |
| "Applications" (macOS) | التطبيقات | Quote macOS Arabic wording |
| "System Settings > Privacy & Security" (macOS) | إعدادات النظام > الخصوصية والأمن | Quote macOS Arabic wording |
| "Open Anyway" (macOS) | فتح على أي حال | Quote macOS Arabic wording |

## Accounts

| English | Arabic | Note |
|---|---|---|
| account | الحساب | |
| sign in / sign out | تسجيل الدخول / تسجيل الخروج | as in Google, Apple, Microsoft |
| passkey | مفتاح المرور | as in Google and Apple Arabic |
| code / one-time code | رمز / رمز يعمل مرة واحدة | Show a code: عرض رمز |
| cloud save | الحفظ السحابي | |
| sync | مزامنة | verb form: تمت المزامنة |
| device | جهاز | |
| join an account | الانضمام إلى حساب | button: انضمام |
| combine saves | دمج الحفظين | |
| driver key | مفتاح السائق | existing term |
| driver names | أسماء السائق | |

## Career

| English | Arabic | Note |
|---|---|---|
| career | المسيرة المهنية | Short: المسيرة when the context is clear; pl. المسيرات |
| career mode | وضع المسيرة المهنية | |
| ladder | السلّم | "سلّم {discipline}"; a tier on it: الدرجة |
| tier | الدرجة | Not مستوى (that is AI level) |
| discipline | نوع السباقات | Road racing: سباقات الحلبات; Historic racing: السباقات الكلاسيكية |
| series | السلسلة | pl. السلاسل |
| season | الموسم | pl. مواسم |
| round | الجولة | pl. جولات; never لفة (lap) |
| promotion / promoted | الصعود / تم الصعود | Promotion cut: خط الصعود |
| attempt | المحاولة | "المحاولة 1 من 3" |
| mulligan | فرصة إعادة | dual فرصتا إعادة, pl. فرص إعادة; a round raced again |
| bonus objective | الأهداف الإضافية | sg. هدف إضافي |
| test day | يوم الاختبار | |
| pre-season | ما قبل الموسم | |
| standings | ترتيب البطولة | Short: الترتيب; championship: البطولة |
| calendar / schedule | الروزنامة / الجدول | |
| career score / race score / season score | رصيد المسيرة / رصيد السباق / رصيد الموسم | رصيد, not نتيجة (race result) and not نقاط (championship points) |
| multiplier | المضاعف | |
| points (pts) | نقطة / النقاط | "{points} نقطة" |
| regions: Americas, Europe, Asia-Pacific | الأمريكتان، أوروبا، آسيا والمحيط الهادئ | "{series} ({region})" |
| series names | كأس الأندية، كأس الكوبيه، كأس السيارات السياحية، GT الكلاسيكية، كأس النماذج الأولية، GT3، نماذج التحمل الأولية، الجائزة الكبرى، سلسلة Procar، كلاسيكيات المجموعة 4، أساطير Can-Am | |
