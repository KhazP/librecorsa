# LibreCorsa Türkçe Çeviri Sözlüğü ve Stil Rehberi

## Stil

- **Dil ve üslup:** Standart Türkiye Türkçesi (İstanbul Türkçesi). Oyuncuya her yerde samimi "sen" diliyle hitap edilir (modern Türkçe oyunlarda olduğu gibi). Geliştiricinin kendi sesiyle konuştuğu mesajlarda birinci tekil şahıs korunur. Metinler, Türkçe konuşan bir sim yarışçısının yazdığı kadar doğal ve akıcı olmalıdır.
- **Buton ve etiketler:** Türkçe yazılımlarda alışılagelmiş kısa biçimler kullanılır (`Kaydet`, `Devam`, `Ayarlar`, `Sıfırla`, `Çık`, `Sür`). Tasarım gereği büyük harf çizilen etiketler normal harf düzeniyle yazılır (Türkçe `ı/I`, `i/İ` kurallarına her zaman dikkat edilir).
- **HUD kısaltmaları:** HUD panelleri dardır; metinler olabildiğince kısa tutulur. `FL`, `PB`, `ELEC`, `TYRE`, `L{lap}`, `T{turn}` gibi Latin kısaltmalar ya aynen bırakılır ya da çok kısa tam Türkçe kelime kullanılır; yeni kısaltma uydurulmaz.
- **Korunan terimler:** Araç, pist ve pilot adları, `LibreCorsa`, `DRS`, `ERS`, `ABS`, `TC`, `MFD`, `HUD`, `FFB`, `km/h`, `mph`, `rpm`, `S1/S2/S3`, `P1/P2`, klavye tuş adları (`Esc`, `Shift`, `Enter`, `Space`, `F8`, `WASD`, `Ctrl+V`) ve kontrolcü tuş adları (`Cross`, `Circle`, `A`, `B`, `L3`, `R2`, `LB`...) aynen korunur.
- **Sayılar ve çoğullar:** Türkçede sayıdan sonra gelen ad her zaman tekil kalır (`3 tur`, asla `3 turlar`). ICU plural dallarında `one` ve `other` ikisi de tekil adla yazılır (`{count, plural, one {# tur} other {# tur}}`); İngilizcede `=0` veya `=1` dalı varsa korunur.
- **Noktalama ve kesme işareti:** ASCII kesme işareti (`'`) kesinlikle kullanılmaz; özel adlara, kısaltmalara ve sayılara gelen eklerde her zaman tipografik kesme işareti (`’`) kullanılır (`LibreCorsa’da`, `F1’de`, `P1’e`, `DRS’yi`).

## Terimler

| English | Türkçe | Not |
|---|---|---|
| Drive | Sür | Ana menü eylemi (sürüşe başla) |
| lap | tur | Sayıdan sonra her zaman tekil (`3 tur`) |
| lap time | tur zamanı | |
| best lap | en iyi tur | |
| fastest lap | en hızlı tur | |
| personal best | kişisel en iyi | Dar HUD alanlarında `PB` korunur |
| last lap | son tur | |
| out lap | çıkış turu | Pit çıkış turu |
| sector | sektör | `S1`, `S2`, `S3` aynen korunur |
| lap board | tur tablosu | Pist ve araç bazlı çevrimiçi tur listesi |
| Hall of Fame | Onur Listesi | Tüm zamanların tur rekorları |
| weekly challenge | haftalık mücadele | |
| time trial | zamana karşı | |
| practice | antrenman | |
| race | yarış | |
| AI race | yapay zeka yarışı | Dar HUD’da gerekirse `YZ` |
| grid | grid | Türk motor sporları kullanımında yerleşik |
| pole position | pole pozisyonu | |
| pit lane | pit yolu | |
| pit limiter | pit hız sınırlayıcı | Dar HUD’da `Pit sınırlayıcı` |
| track limits | pist sınırları | |
| lap deleted | tur silindi | |
| racing line | yarış çizgisi | İdeal çizgi göstergesi |
| braking point | fren noktası | |
| apex | apeks | |
| kerb | kerb | Sim yarışçıları arasında yerleşik |
| run-off | kaçış alanı | |
| circuit | pist | |
| layout | düzen | Bağlama göre `pist düzeni` |
| hill climb | tırmanma | TOSFED/Türk motor sporları terimi |
| point-to-point | noktadan noktaya | |
| car | araç | Genel arayüz/ayar terimi |
| class | sınıf | Araç sınıfı |
| ghost | hayalet | Bağlama göre `hayalet araç` |
| share code | paylaşım kodu | |
| room / room code / host / join | oda / oda kodu / kurucu (oda kur) / katıl | Çok oyunculu oda terimleri |
| driver | pilot | Motor sporları bağlamında (`sürücü` yerine) |
| force feedback | force feedback | Kısaltma: `FFB` |
| steering wheel / wheel | direksiyon | Araç tekeri için `tekerlek` |
| pedals | pedallar | |
| throttle | gaz | |
| brake | fren | |
| clutch | debriyaj | |
| handbrake | el freni | |
| gear up / gear down | vites yükselt / vites düşür | |
| paddle shifters | vites kulakçıkları | |
| manual gearbox / automatic gearbox | manuel vites / otomatik vites | Mekanik bağlamda `şanzıman` |
| dead zone | ölü bölge | |
| steering lock / full lock | direksiyon kilidi / tam kilit | |
| steering rotation | direksiyon dönüş açısı | Dar alanda `dönüş açısı` |
| sensitivity | hassasiyet | |
| linearity | doğrusallık | |
| gyro steering | jiroskop direksiyon | |
| controller | kontrolcü | Gamepad |
| keyboard | klavye | |
| touch controls | dokunmatik kontroller | |
| bind | ata | Tuş veya eksen atama |
| axis | eksen | |
| calibrate | kalibre et | İsim: `kalibrasyon` |
| driving assists | sürüş destekleri | |
| traction control | çekiş kontrolü | Kısaltma: `TC` |
| ABS | ABS | Aynen korunur |
| stability control | denge kontrolü | |
| brake bias | fren dengesi | |
| tyre wear | lastik aşınması | |
| tyre temperatures | lastik sıcaklıkları | |
| tyre pressure | lastik basıncı | |
| tyre compound: soft, medium, hard, intermediate, wet | lastik hamuru: yumuşak, orta, sert, geçiş, yağmur | Standart Türkçe F1 hamur adları |
| tyre blankets | lastik battaniyeleri | |
| setup (car setup) | araç ayarı | İlk çalıştırma kurulumu için `kurulum`, Ayarlar ekranı için `Ayarlar` |
| apply setup | ayarı uygula | |
| suspension | süspansiyon | |
| ride height | sürüş yüksekliği | |
| springs | yaylar | |
| dampers | amortisörler | |
| bump / rebound (fast bump, slow rebound) | sıkıştırma / geri sekme (hızlı sıkıştırma, yavaş geri sekme) | |
| anti-roll bar | viraj demiri | |
| camber | kamber | |
| toe | toe | Bağlama göre `toe açısı` |
| downforce | yere basma kuvveti | Dar alanda `yere basma` |
| rear wing / front wing | arka kanat / ön kanat | |
| active aero | aktif aero | |
| drag | hava direnci | |
| grip / front grip / rear grip | yol tutuşu / ön tutuş / arka tutuş | Kısa: `tutuş` |
| understeer / oversteer | önden kayma / arkadan kayma | |
| differential | diferansiyel | |
| gear ratios | vites oranları | |
| fuel | yakıt | |
| yellow / double yellow / blue / black / chequered / green flag | sarı bayrak / çift sarı / mavi bayrak / siyah bayrak / damalı bayrak / yeşil bayrak | |
| safety car | güvenlik aracı | |
| penalty / time penalty / drive-through | ceza / zaman cezası / pitten geçme cezası | |
| lights out | ışıklar söndü | |
| jump start | erken çıkış | |
| overtake / overtake mode | geçiş yap (solla) / geçiş modu | F1 2026 enerji takviyesi: `geçiş modu` |
| ERS / DRS / deploy / harvest | ERS / DRS / dağıtım (kullan) / geri kazanım (şarj) | `ERS` ve `DRS` korunur |
| battery | batarya | |
| HUD | HUD | Aynen korunur |
| proximity radar | yakınlık radarı | |
| shift lights / rev lights | vites ışıkları / devir ışıkları | |
| delta | delta | Referans tura göre zaman farkı |
| gap | fark | Öndeki/arkadaki araçla fark |
| position | sıra | Bağlama göre `pozisyon` |
| mirror | ayna | Bağlama göre `dikiz aynası` |
| camera: chase camera, cockpit, bonnet camera, Trackside TV, free camera | kamera: takip kamerası, kokpit, kaput kamerası, Pist Kenarı TV, serbest kamera | |
| replay | tekrar | |
| pause menu / main menu | duraklatma menüsü / ana menü | |
| restart / retry / quit / continue | yeniden başlat / tekrar dene / çık / devam et | Butonlarda `Devam` veya `Devam Et` |
| Settings / Display / Audio / Controls / Graphics / Gameplay | Ayarlar / Görüntü / Ses / Kontroller / Grafikler / Oynanış | |
| quality (Low, Medium, High, Ultra) | kalite (Düşük, Orta, Yüksek, Ultra) | |
| frame rate | kare hızı | Kısaltma: `FPS` |
| resolution | çözünürlük | |
| Reset / Restore default | Sıfırla / Varsayılana Dön | |
| weather: clear, cloudy, overcast, rain, wet track, dry track | hava durumu: açık, bulutlu, kapalı, yağmurlu, ıslak pist, kuru pist | |
| time of day / night | günün saati / gece | |
| realism (Full realism) | gerçekçilik (Tam gerçekçilik) | |
| physics / physics version | fizik / fizik sürümü | |
| post (a lap) / upload | gönder / yükle | Tur tablosuna gönderme: `gönder` |
| Lap times | Tur zamanları | Tur zamanları ekranı |

## Accounts

| English | Türkçe | note |
|---|---|---|
| account | hesap | |
| sign in / sign out | giriş yap / çıkış yap | Düğmede kısa hali |
| way to sign in | giriş yöntemi | Discord, Google, Steam, geçiş anahtarı |
| passkey | geçiş anahtarı | Google ve Apple'ın Türkçe terimi |
| code (one-time) | kod / tek kullanımlık kod | Başka bir cihazı hesaba bağlayan kod |
| cloud save | bulut kaydı | |
| save (the game's) | kayıt | |
| sync | senkronize et | |
| device | cihaz | |
| join an account | hesaba katıl | |
| combine saves | kayıtları birleştir | |
| driver key | pilot anahtarı | Mevcut terim |
