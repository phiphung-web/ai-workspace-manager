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

## Limit tự động

Sau khi một tài khoản đăng nhập, dashboard dùng Codex App Server chính thức để
đọc:

- Phần trăm đã dùng/còn lại của cửa sổ Codex.
- Thời điểm reset.
- Cửa sổ phụ nếu tài khoản có nhiều loại giới hạn.
- Thống kê token tài khoản khi dịch vụ cung cấp.

Limit được cập nhật sau mỗi lượt Codex, sau khi đổi tài khoản, hoặc khi bấm nút
`↻` cạnh tiêu đề **Tài khoản**. Không cần nhập phần trăm thủ công.

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

## Kiểm tra

```powershell
npm run check
```
