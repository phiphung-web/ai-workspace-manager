# Codex Workspace Manager

Dashboard local để quản lý nhiều dự án, nhiều cuộc trò chuyện và chuyển tài
khoản Codex mà không làm mất trạng thái công việc.

## Chạy

Mở PowerShell trong thư mục dự án:

```powershell
npm start
```

Sau đó mở:

```text
http://127.0.0.1:4320
```

Không cần cài package ngoài. Yêu cầu Node.js 20+ và Codex CLI đã được cài.
Dashboard tự tìm `codex` trong `PATH` và trong extension OpenAI ChatGPT/Codex
của VS Code trên Windows. Nếu bạn dùng vị trí khác, đặt biến `CODEX_BIN` thành
đường dẫn tuyệt đối tới `codex.exe` trước khi chạy.

## Cách tiếp tục sau khi đổi tài khoản

1. Trong dashboard, cập nhật **Tóm tắt hiện tại** và **Việc tiếp theo**.
2. Chọn tài khoản muốn chuyển sang.
3. Nếu đây là lần đầu dùng tài khoản đó, dashboard mở luồng `codex login`
   chính thức trong trình duyệt.
4. Những lần sau chỉ cần bấm chọn, không logout và không đăng nhập lại.
5. Gửi tin nhắn tiếp theo trong cuộc trò chuyện cũ.

Cuộc trò chuyện trên dashboard vẫn giữ nguyên. Lượt đầu tiên sau khi đổi tài
khoản tạo một Codex session mới và gửi kèm bản tóm tắt, các tin nhắn gần nhất
cùng yêu cầu kiểm tra Git để tiếp tục đúng trạng thái.

Context bridge có ngân sách ký tự và lấy tối đa 80 lượt gần nhất, thay vì cố định
vài tin nhắn. Yêu cầu hiện tại được loại khỏi phần lịch sử để không bị xử lý
lặp. Trạng thái file luôn được xác minh lại từ repository và Git.

Nếu Codex dừng vì chạm hạn mức, dashboard tự tạo **handoff capsule** gồm mục
tiêu, yêu cầu đang chạy, hoạt động cuối, việc tiếp theo, nhánh/commit, `git
status` và thống kê diff. Một banner sẽ đề xuất profile đã đăng nhập còn nhiều
hạn mức nhất. Bạn xác nhận bằng nút **Tiếp tục task**; yêu cầu dở dang được chạy
lại trong chat cũ mà không phải nhập hoặc giải thích lại. Snapshot Git chỉ đọc,
dashboard không tự commit, stash hay thay đổi working tree.

## Limit tự động

Sau khi một tài khoản đăng nhập, dashboard dùng Codex App Server chính thức để
đọc:

- Phần trăm đã dùng/còn lại của cửa sổ Codex.
- Thời điểm reset.
- Cửa sổ phụ nếu tài khoản có nhiều loại giới hạn.
- Thống kê token tài khoản khi dịch vụ cung cấp.
- Chi tiết riêng cho cửa sổ ngắn hạn và dài hạn, gồm phần trăm còn lại và giờ reset.

Limit được cập nhật sau mỗi lượt Codex, sau khi đổi tài khoản, hoặc khi bấm nút
`↻` cạnh tiêu đề **Tài khoản**. Không cần nhập phần trăm thủ công.

Mỗi tài khoản có thể lưu thêm thời gian hết hạn và ghi chú quản trị. Dashboard
cảnh báo số ngày còn lại, đánh dấu tài khoản đã hết hạn và không đề xuất tài
khoản đó cho việc bàn giao task.

## Tối ưu context và chat dài

Mỗi project có cấu hình riêng trong panel **Ngữ cảnh bàn giao**:

- Giữ mục tiêu ban đầu cộng các lượt gần nhất, hoặc chỉ lấy các lượt gần nhất.
- Giới hạn số lượt từ 10–200.
- Ngân sách lịch sử từ 8.000–100.000 ký tự.
- Ngưỡng cảnh báo chat dài từ 40–500 lượt.

Những giới hạn này chỉ áp dụng cho prompt bàn giao sang profile khác. Lịch sử
đầy đủ vẫn được giữ trong `.data/state.json`; checkpoint thủ công và Git
snapshot luôn được gửi riêng nên chat dài không làm mất trạng thái code.

## OpenAI và Claude làm AI phụ trợ

Thêm provider trong mục **AI phụ trợ**, nhập loại API, model, key và số token
ban đầu mà bạn muốn tool quản lý. Key được mã hóa bằng Windows DPAPI theo user
Windows hiện tại và chỉ ciphertext nằm trong `.data/secrets.json`; key không có
trong `state.json` và không được trả lại frontend.

Dashboard hiển thị:

- OpenAI hay Claude, model đang chọn và độ khả dụng của key/model.
- Token do người dùng khai báo, tổng đã dùng, còn lại và phần trăm khả dụng.
- Breakdown input, cached input, cache write và output token.
- Số lượt API, lần kiểm tra gần nhất và lỗi provider.

Trong composer, chọn một provider tại **AI phụ trợ**. Dashboard gọi provider
chỉ sau khi hiển thị popup xin phép gồm lý do, model, dữ liệu chuẩn bị gửi,
ước tính token tối đa, số dư còn lại và secret đã che. Sau khi người dùng cho
phép, dashboard gọi provider, ghi usage thật từ response rồi đưa kết quả cho
Codex kiểm tra với repository và tiếp tục triển khai. Nếu từ chối, provider lỗi
hoặc hết ngân sách do tool theo dõi, Codex tiếp tục một mình và ghi cảnh báo.

Popup có ba lựa chọn:

- **Cho phép lần này**: chỉ lượt hiện tại được gọi provider.
- **Tự động trong project**: các lượt sau với cùng provider không dừng chờ,
  nhưng dashboard vẫn báo trước khi gọi và báo usage sau khi xong.
- **Không dùng, Codex tiếp tục**: không gọi provider và không phát sinh API usage.

Chính sách tự động lưu theo cặp project/provider. Nút **Tắt tự động** xuất hiện
trên thẻ provider khi project hiện tại đã cho phép tự động.

Số dư token là sổ theo dõi local, không phải số dư được OpenAI/Anthropic xác
nhận. Tool không biết phần usage phát sinh khi cùng key được dùng ở ứng dụng
khác. OpenAI cached tokens là một phần của input tokens nên không bị trừ hai
lần; với Claude, cache read/write được cộng theo usage response của Anthropic.

Mỗi project được tạo thư mục `.codex-manager/`:

- `CURRENT.md`: trạng thái ngắn hiện tại và Git checkpoint.
- `HISTORY.md`: lịch sử hoàn thành lượt và bàn giao quota.
- `AI_USAGE.json`: provider/model, lý do, phạm vi dữ liệu, phê duyệt và usage.

Các file memory được lọc mẫu secret phổ biến trước khi ghi. Chúng làm working
tree thay đổi để có thể đi theo project; người dùng tự quyết định commit hoặc
thêm `.codex-manager/` vào `.gitignore`.

## Dữ liệu và bảo mật

- Server chỉ lắng nghe tại `127.0.0.1`.
- Không lưu mật khẩu, cookie, OAuth token hoặc API key.
- Tài khoản trong dashboard chỉ là nhãn để bạn quản lý.
- Mỗi tài khoản có một `CODEX_HOME` riêng tại `.data/profiles/<account-id>`.
- Codex CLI tự quản lý auth và session trong từng profile; dashboard không đọc
  hoặc sao chép token.
- Dữ liệu dashboard nằm trong `.data/state.json` và bị Git ignore.
- Không mở trực tiếp cổng 4320 ra Internet. Nếu cần truy cập từ xa, dùng VPN
  riêng như Tailscale.
- Không tự động xoay tài khoản, đổi IP hay dùng proxy để né rate limit/hệ thống
  phát hiện. Proxy mạng hợp lệ nếu cần phải được cấu hình minh bạch bên ngoài tool.

## Kiểm tra

```powershell
npm run check
```
