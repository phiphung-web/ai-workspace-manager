# AI Workspace Manager

Workspace cục bộ để quản lý nhiều hồ sơ Codex, dự án và cuộc trò chuyện trong
một luồng làm việc liên tục. Khi một tài khoản chạm hạn mức, hệ thống chuẩn bị
ngữ cảnh bàn giao để hồ sơ tiếp theo tiếp quản mà không phải rà soát lại từ đầu.

## Chạy

AI tiếp theo cần đọc [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md) trước khi tiếp tục
thay đổi kiến trúc hoặc kiểm tra MCP.

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

1. Trong workspace, cập nhật **Tóm tắt tiến độ** và **Hành động tiếp theo**.
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
hạn mức nhất. Bạn xác nhận bằng nút **Bàn giao và tiếp tục**; yêu cầu dở dang được chạy
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

## ChatGPT Plus lập kế hoạch, Gemini Pro review, Codex triển khai

Đây là chế độ mặc định và **không cần API key**. Tool dùng hạn mức trong các ứng
dụng thuê bao mà bạn đã có, không gọi OpenAI API hay Gemini API và không tạo phí
API. Luồng thực tế:

1. Dashboard tạo context pack cục bộ đã che mẫu secret, gồm yêu cầu, checkpoint,
   trao đổi gần nhất, cây file, Git status/diff stat và các file liên quan.
2. ChatGPT Plus lấy task qua MCP, lập kế hoạch và lưu lại vào kho task cục bộ.
3. Gemini Pro lấy kế hoạch GPT cùng context dự án qua MCP, review và lưu kế hoạch
   cuối.
4. Dashboard phát hiện review đã xong và tự chuyển kế hoạch cuối sang tài khoản
   Codex đang chọn để sửa code, chạy test và báo kết quả.

Subscription không cung cấp một API ngầm để dashboard tự bấm nút thay người
dùng. Bạn vẫn cần mở ChatGPT và Gemini, gửi một câu lệnh ngắn cho mỗi ứng dụng;
MCP giúp hai ứng dụng tự lấy đúng task và tự lưu kết quả nên không phải copy code,
paste kế hoạch hoặc giải thích lại dự án.

### Kết nối MCP cục bộ một lần

Server MCP dùng cùng thư mục `.data` với dashboard:

```text
Command: node
Arguments: C:\duong-dan\ai-workspace-manager\mcp-server.mjs
Environment: AI_WORKSPACE_DATA_DIR=C:\duong-dan\ai-workspace-manager\.data
```

Trong ChatGPT desktop, mở **Settings → MCP servers** và thêm STDIO server bằng
command/arguments/environment ở trên. Sau khi gửi task trong dashboard, nói:

```text
Dùng AI Workspace, lấy task đang chờ GPT lập kế hoạch, lập kế hoạch đầy đủ rồi
lưu lại bằng tool tương ứng.
```

Trong Gemini/Antigravity, thêm vào `~/.gemini/config/mcp_config.json` hoặc file
`.agents/mcp_config.json`:

```json
{
  "mcpServers": {
    "ai-workspace": {
      "command": "node",
      "args": ["C:\\duong-dan\\ai-workspace-manager\\mcp-server.mjs"],
      "env": {
        "AI_WORKSPACE_DATA_DIR": "C:\\duong-dan\\ai-workspace-manager\\.data"
      }
    }
  }
}
```

Khi dashboard báo chờ Gemini, nói:

```text
Dùng AI Workspace, lấy task đang chờ Gemini review, kiểm tra kỹ kế hoạch rồi lưu
review và kế hoạch cuối bằng tool tương ứng.
```

Nếu ứng dụng ChatGPT/Gemini của tài khoản hiện tại không cho thêm MCP, không có
cách hợp lệ để tool tự dùng quota subscription của ứng dụng đó như API. Khi ấy
chọn **Codex làm trực tiếp**, hoặc dùng thao tác sao chép thủ công; không cần mua
API chỉ để dùng các chức năng Codex chính.

### API tự động là mục nâng cao, mặc định tắt

Mục **API nâng cao** chỉ dành cho người chủ động muốn dashboard tự gọi provider
mà không mở ứng dụng ChatGPT/Gemini. API key được mã hóa bằng Windows DPAPI;
dashboard luôn xin phép và cảnh báo khả năng phát sinh phí trước khi gọi. Không
cấu hình key và không chọn chế độ này thì không có request API nào được gửi.

Mỗi project được tạo thư mục `.codex-manager/`:

- `CURRENT.md`: trạng thái ngắn hiện tại và Git checkpoint.
- `HISTORY.md`: lịch sử hoàn thành lượt và bàn giao quota.
- `AI_USAGE.json`: provider/model, lý do, phạm vi dữ liệu, phê duyệt và usage.
- `PLAN_CURRENT.md`: kế hoạch GPT, review Gemini và kết quả Codex gần nhất.
- `PLANS/<job-id>.md`: hồ sơ từng lần lập kế hoạch và thực thi để AI khác tiếp
  tục dự án mà không phải rà soát lại từ đầu.

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
