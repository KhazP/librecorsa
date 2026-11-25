# Bảng thuật ngữ bản địa hóa tiếng Việt — LibreCorsa

## Phong cách (Style)

- **Biến thể & xưng hô:** Tiếng Việt tiêu chuẩn, đầy đủ dấu thanh trong mọi chuỗi. Xưng hô với người chơi là **bạn** một cách nhất quán. Các câu mang giọng của nhà phát triển ("I'll keep trying", "I got permission") giữ ngôi thứ nhất (**tôi**).
- **Nút bấm & nhãn giao diện:** Ngắn gọn, trực diện theo phong cách game đua xe (động từ hoặc danh từ ngắn: *Lái xe*, *Tiếp tục*, *Đặt lại*). Viết hoa đầu câu bình thường, không viết HOA toàn bộ dù thiết kế hiển thị chữ hoa.
- **HUD trong cuộc đua:** Giữ ngắn tối đa cho các khóa `hud.` và `hudStyles.`. Giữ nguyên các mã viết tắt Latin (`FL`, `PB`, `ELEC`, `TYRE`, `L{lap}`, `T{turn}`, `S1/S2/S3`, `P1/P2`, `DRS`, `ERS`, `ABS`, `TC`, `MFD`, `HUD`, `FFB`, `km/h`, `mph`, `rpm`) hoặc dùng từ tiếng Việt thật ngắn, không tự chế ký hiệu viết tắt mới.
- **Dấu câu & định dạng:** Dấu câu tiếng Việt tiêu chuẩn. Tuyệt đối không dùng dấu nháy đơn ASCII `'`; dùng dấu nháy cong `’` nếu thực sự cần (ví dụ tên riêng) hoặc diễn đạt lại. Số nhiều ICU dùng duy nhất nhánh `other` (giữ nguyên các nhánh chính xác `=0`, `=1` nếu bản tiếng Anh có).
- **Giữ nguyên tiếng Anh/Latin:** Tên xe, tên đường đua, tên tay đua, *LibreCorsa*, tên phím (`Esc`, `Shift`, `Enter`, `Space`, `F8`, `WASD`, `Ctrl+V`), nút tay cầm (`Cross`, `Circle`, `A`, `B`, `L3`, `R2`, `LB`…).

## Bảng thuật ngữ (Glossary)

| English | Tiếng Việt | Ghi chú |
|---|---|---|
| Drive | Lái xe | Nút hành động chính trên menu để bắt đầu lái |
| lap | vòng / vòng đua | Dùng *vòng* trong HUD/nhãn ngắn, *vòng đua* khi cần rõ nghĩa |
| lap time | thời gian vòng | HUD ngắn: *TG vòng* hoặc *Vòng* |
| best lap | vòng tốt nhất | |
| fastest lap | vòng nhanh nhất | Giữ `FL` khi ở dạng mã HUD |
| personal best | kỷ lục cá nhân | Giữ `PB` khi ở dạng mã HUD |
| last lap | vòng trước | |
| final lap | vòng cuối | Vòng cuối cùng của cuộc đua; phân biệt với *vòng trước* (last lap) |
| out lap | vòng xuất pit | Vòng chạy ra từ làn pit |
| optimal lap | lý tưởng | Nhãn HUD ngắn |
| predicted lap | dự kiến | Dạng ngắn trên HUD cũng là *Dự kiến* |
| on a PB | Vượt PB | Nhãn HUD ngắn |
| reference lap | vòng tham chiếu | |
| compared lap | vòng so sánh | |
| lap comparison | so sánh vòng | |
| sector | sector | Giữ nguyên thuật ngữ quen thuộc với cộng đồng F1/sim racing VN; giữ `S1/S2/S3` |
| lap board | bảng xếp hạng vòng | Bảng thành tích trực tuyến theo đường đua và xe |
| Hall of Fame | Đại sảnh Danh vọng | Bảng kỷ lục mọi thời đại |
| GOAT (badge) | GOAT | Giữ nguyên tiếng Anh (phổ biến trong giới thể thao); tên và nhãn ngắn của huy hiệu |
| weekly challenge | thử thách tuần | |
| time trial | đua tính giờ | |
| practice | luyện tập | |
| race | cuộc đua / đua chính | Chế độ chơi: *Đua*; phiên đua chính: *Đua chính* |
| AI race | đua với AI | |
| grid | hàng xuất phát | Vị trí xuất phát: *vị trí xuất phát*; trên vạch: *trên hàng xuất phát* |
| pole position | vị trí pole | Thuật ngữ chuẩn cộng đồng đua xe VN |
| pit lane | làn pit | |
| pit limiter | giới hạn tốc độ pit | HUD ngắn: *Giới hạn pit* |
| limiter | giới hạn tốc độ | `Đang giới hạn tốc độ` cho Limiter on |
| track limits | giới hạn đường đua | |
| lap deleted | vòng bị hủy | Thành tích vòng bị hủy do vượt giới hạn đường đua |
| racing line | đường chạy lý tưởng | Nhãn ngắn: *Đường chạy* |
| driving line | đường chạy | Quỹ đạo xe đã chạy, phân biệt với *đường chạy lý tưởng* |
| braking point | điểm phanh | |
| apex | đỉnh cua | |
| kerb | gờ lề | Gờ lề đỏ-trắng ở mép đường đua (không dùng *gờ giảm tốc*) |
| run-off | vùng thoát hiểm | |
| circuit | đường đua | |
| layout | bố cục | Bố cục / biến thể của một đường đua |
| hill climb | đua leo đồi | |
| point-to-point | điểm-đến-điểm | Cung đường không khép kín |
| car | xe | |
| class | hạng xe | Nhãn ngắn: *Hạng* |
| livery | màu sơn | |
| ghost | xe bóng ma | Xe mờ ghi lại vòng chạy mẫu; nhãn ngắn: *Bóng ma* |
| ghost mode | chế độ bóng ma | Chế độ chơi mạng không va chạm |
| share code | mã chia sẻ | Mã văn bản chia sẻ vòng đua hoặc thiết lập xe |
| room / room code / host / join | phòng / mã phòng / chủ phòng / tham gia | Động từ *host*: *tạo phòng* hoặc *làm chủ phòng* |
| lobby | sảnh chờ | Ngắn: *sảnh* |
| driver | tay đua | |
| force feedback | phản hồi lực | Giữ `FFB` khi viết tắt |
| steering wheel / wheel | vô lăng | |
| pedals | bàn đạp | |
| throttle | chân ga | Nhãn ngắn/HUD: *Ga* |
| brake | phanh | |
| clutch | côn | Bàn đạp côn |
| handbrake | phanh tay | |
| gear up / gear down | lên số / về số | Tự nhiên theo cách nói lái xe tiếng Việt |
| paddle shifters | lẫy chuyển số | |
| manual gearbox / automatic gearbox | hộp số sàn / hộp số tự động | Nhãn ngắn: *Số sàn* / *Số tự động* |
| dead zone | vùng chết | |
| steering lock / full lock | góc đánh lái tối đa / đánh hết lái | |
| steering rotation | góc xoay vô lăng | Tính theo độ xoay vô lăng |
| sensitivity | độ nhạy | |
| linearity | độ tuyến tính | |
| gyro steering | lái con quay hồi chuyển | Nhãn ngắn: *Lái con quay* |
| controller | tay cầm | Gamepad |
| keyboard | bàn phím | |
| touch controls | điều khiển cảm ứng | |
| bind | gán | Gán phím / gán nút / gán trục |
| unbind | gỡ gán | |
| axis | trục | |
| calibrate | hiệu chỉnh | |
| driving assists | hỗ trợ lái | |
| traction control | kiểm soát lực kéo | Giữ `TC` |
| TC slip angle | góc trượt TC | |
| ABS | ABS | Giữ nguyên |
| stability control | kiểm soát ổn định | |
| brake bias | phân bổ lực phanh | HUD ngắn: *Phân bổ phanh* |
| brake migration | dịch chuyển lực phanh | HUD ngắn: *Dịch chuyển phanh* |
| tyre wear | độ mòn lốp | Ngắn: *Mòn lốp* |
| tread | gai lốp | Gai lốp còn lại: *gai lốp còn*; bề mặt nhiệt độ lốp dùng *mặt lốp* |
| flat / puncture | thủng / thủng lốp | Nhãn HUD ngắn: *Thủng* (flat), *Thủng lốp* (puncture) |
| tyre temperatures | nhiệt độ lốp | |
| tyre pressure | áp suất lốp | |
| tyre compound: soft, medium, hard, intermediate, wet | loại lốp: Mềm, Trung bình, Cứng, Trung gian, Mưa | Chuẩn F1 & sim racing tiếng Việt |
| tyre blankets | chăn ủ lốp | |
| setup | thiết lập xe | Ngắn: *Thiết lập* |
| apply setup | áp dụng thiết lập | |
| suspension | hệ thống treo | Ngắn: *Treo* |
| ride height | độ cao gầm | |
| springs | lò xo | |
| dampers | giảm chấn | |
| bump / rebound | nén / hồi | *nén nhanh*, *nén chậm*, *hồi nhanh*, *hồi chậm* |
| bumpstop | đệm chặn | Chú giải telemetri: *Đệm chặn* |
| bumpstop travel | hành trình đệm chặn | |
| anti-roll bar | thanh cân bằng | |
| camber | góc camber | Ngắn: *Camber* |
| toe | độ chụm | *chụm vào* (toe-in), *loe ra* (toe-out) |
| downforce | lực ép | Khi cần đầy đủ: *lực ép khí động* |
| rear wing / front wing | cánh gió sau / cánh gió trước | |
| active aero | khí động học chủ động | |
| drag | lực cản gió | Ngắn: *Lực cản* |
| aero balance | cân bằng khí động | Nhãn telemetri ngắn: *Cân bằng* |
| grip / front grip / rear grip | độ bám / độ bám trước / độ bám sau | |
| slip | trượt | Chú giải telemetri: *Trượt* |
| understeer / oversteer | thiếu lái / thừa lái | |
| differential | vi sai | |
| diff lock | khóa vi sai | Nhãn telemetri ngắn: *Khóa LSD* |
| gear ratios | tỉ số truyền | |
| fuel | nhiên liệu | |
| fuel margin: spare / short | dư / thiếu | |
| yellow flag / double yellow / blue flag / black flag / chequered flag / green flag | cờ vàng / cờ vàng kép / cờ xanh dương / cờ đen / cờ ca-rô / cờ xanh lá | |
| double yellow (short) | Vàng kép | Nhãn HUD ngắn |
| blue flag (short) | Xanh dương | Nhãn HUD ngắn |
| safety car | xe an toàn | |
| VSC ending | VSC sắp hết | Dạng đầy đủ: *VSC sắp kết thúc*; cực ngắn: *VSC hết* |
| penalty / time penalty / drive-through | án phạt / phạt thời gian / phạt chạy qua làn pit | Ngắn: *Phạt* / *Chạy qua pit* |
| retired | bỏ cuộc | Giữ nguyên `DNF` |
| disqualified | bị truất quyền thi đấu | Giữ nguyên `DSQ` |
| damage: minor / heavy | nhẹ / nặng | |
| lights out | tắt đèn xuất phát | |
| jump start | xuất phát sớm | |
| formation | xếp đội hình | Xuất phát lăn bánh |
| overtake / overtake mode | vượt / chế độ vượt | Chế độ tăng năng lượng F1 2026 |
| ERS / DRS / deploy / harvest | ERS / DRS / xả năng lượng / thu hồi năng lượng | Ngắn: *Xả* / *Thu hồi* |
| MGU-K | MGU-K | Giữ nguyên |
| regeneration / regen | thu hồi năng lượng / Thu hồi | HUD ngắn: *Thu hồi* |
| battery | pin | |
| HUD | HUD | Giữ nguyên |
| Blade | Thanh nghiêng | Tên bố cục HUD |
| Trackside | Ven đường đua | Tên bố cục HUD |
| Pit wall | Tường pit | Tên bố cục HUD |
| Endurance | Đua bền bỉ | Tên bố cục HUD |
| Racing line | Đường chạy lý tưởng | Tên bố cục HUD |
| proximity radar | radar khoảng cách | |
| spotter | spotter | Giữ nguyên |
| team radio / radio sound | bộ đàm đội đua / âm thanh bộ đàm | |
| shift lights / rev lights | đèn chuyển số / đèn vòng tua | |
| delta | delta / chênh lệch | Giữ *Delta* trong HUD; dùng *chênh lệch* khi giải thích |
| gap | khoảng cách | Khoảng cách thời gian với xe trước/sau |
| interval | cách trước | Dạng đầy đủ: *cách xe trước*; cột hẹp `blade` dùng `INT` |
| gap to leader | cách xe dẫn đầu | Dài hơn: *khoảng cách với xe dẫn đầu*; ngắn: *Cách đầu* |
| relative | xe lân cận | Bảng các xe ngay phía trước và phía sau trên đường đua |
| position | vị trí | |
| mirror | gương chiếu hậu | Ngắn: *Gương* |
| camera: chase camera, cockpit, bonnet camera, Trackside TV, free camera | camera: camera sau xe, buồng lái, camera nắp ca-pô, TV ven đường đua, camera tự do | |
| replay | phát lại | |
| pause menu / main menu | menu tạm dừng / menu chính | |
| restart / retry / quit / continue | bắt đầu lại / thử lại / thoát / tiếp tục | |
| Settings / Display / Audio / Controls / Graphics / Gameplay | Cài đặt / Hiển thị / Âm thanh / Điều khiển / Đồ họa / Lối chơi | |
| quality (Low, Medium, High, Ultra) | chất lượng (Thấp, Trung bình, Cao, Cực cao) | |
| frame rate | tốc độ khung hình | Giữ `FPS` khi viết tắt |
| resolution | độ phân giải | |
| Reset / Restore default | Đặt lại / Khôi phục mặc định | |
| weather: clear, cloudy, overcast, rain, wet track, dry track | thời tiết: trời quang, có mây, u ám, mưa, đường ướt, đường khô | |
| time of day / night | thời gian trong ngày / ban đêm | |
| realism (Full realism) | độ chân thực (Chân thực tối đa) | |
| physics / physics version | vật lý / phiên bản vật lý | |
| post / upload | đăng / tải lên | Đăng thành tích vòng lên bảng trực tuyến |
| Lap times | Thành tích vòng | Màn hình danh sách thành tích vòng |
| mod | mod | Nhãn: `MOD` |
| mod package | gói mod | |
| mods folder | thư mục mod | |
| import folder | thư mục nhập | Danh từ; nút hành động Import folder: *Nhập thư mục* |
| converter | trình chuyển đổi | Trình chuyển đổi mod |
| converter log | nhật ký trình chuyển đổi | Nhật ký = log |
| fingerprint | mã xác thực | Mã kiểm tra SHA-256 |
| launcher | trình khởi chạy | |
| offline launcher | trình khởi chạy ngoại tuyến | |
| desktop app | ứng dụng máy tính | |
| licence | giấy phép | |
| "More info" (Windows SmartScreen) | Thông tin thêm | Dùng đúng tên tiếng Việt của Windows |
| "Run anyway" (Windows SmartScreen) | Vẫn chạy | Dùng đúng tên tiếng Việt của Windows |
| "Applications" (macOS) | Ứng dụng | Dùng đúng tên tiếng Việt của macOS |
| "System Settings > Privacy & Security" (macOS) | Cài đặt hệ thống > Quyền riêng tư & Bảo mật | Dùng đúng tên tiếng Việt của macOS |
| "Open Anyway" (macOS) | Vẫn mở | Dùng đúng tên tiếng Việt của macOS |

## Accounts

| English | Tiếng Việt | Ghi chú |
|---|---|---|
| account | tài khoản | |
| sign in / sign out | đăng nhập / đăng xuất | |
| passkey | khóa truy cập | Cách Google/Apple gọi; khác với *khóa tay đua* |
| driver key | khóa tay đua | Giữ nguyên thuật ngữ cũ |
| code / one-time code | mã / mã dùng một lần | Nút: *Hiện mã*, *Mã mới* |
| cloud save | bản lưu đám mây | |
| save (noun) | bản lưu | |
| sync | đồng bộ | |
| device | thiết bị | |
| join an account | tham gia tài khoản | Nút: *Tham gia* |
| combine saves / accounts | gộp bản lưu / gộp tài khoản | Nút: *Gộp* |
| driver names | tên tay đua | |

## Career

| English | Tiếng Việt | Ghi chú |
|---|---|---|
| career | sự nghiệp | |
| career mode | chế độ sự nghiệp | |
| ladder | bậc thang | Thẻ và tiêu đề: *Bậc thang {discipline}* |
| tier | bậc | *Bậc {tier}* |
| series | giải đua | Tên giải giữ tiếng Anh, xem bên dưới |
| discipline | thể loại đua | *Đua đường trường* / *Đua xe cổ điển* |
| promotion / promoted | thăng hạng | *vùng thăng hạng*, *vạch thăng hạng* |
| attempt | lần thử | *Lần thử {attempt}/{max}* |
| mulligan | lượt đua lại | |
| bonus objective | mục tiêu thưởng | |
| test day | ngày chạy thử | |
| pre-season | tiền mùa giải | |
| season | mùa giải | Nhãn ngắn: *Mùa {season}* |
| round | chặng | Không dùng *vòng* (đã dành cho lap) |
| standings | bảng xếp hạng giải đấu | Nhãn ngắn: *Bảng xếp hạng* |
| calendar | lịch đua | |
| career score / multiplier | điểm sự nghiệp / hệ số | *{mult}× điểm* |
| pit stop(s) | dừng pit / dừng pit bắt buộc | |
| clean race | cuộc đua sạch | |
| podium (count) | lên bục | *{podiums} lên bục* |
| series names | Club Cup, Coupé Cup, Touring Cup, Classic GT, Prototype Cup, GT3, Nguyên mẫu Sức bền, Grand Prix, Procar Series, Group 4 Classic, Can-Am Legends | Chỉ dịch tên mang tính mô tả |
| regions | Châu Mỹ, Châu Âu, Châu Á-Thái Bình Dương | *{series} {region}* |
