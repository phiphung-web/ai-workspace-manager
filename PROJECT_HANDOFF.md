# AI Workspace Manager — Project Handoff

## Mục tiêu

Đây là workspace local để duy trì một công việc liên tục khi tài khoản Codex chạm hạn mức. Người dùng có một tài khoản ChatGPT Plus để lập kế hoạch, một tài khoản Gemini Pro để review và nhiều tài khoản Codex để luân phiên thực thi. Mục tiêu là không phải giải thích lại dự án, không phải copy/paste context và không dùng OpenAI/Gemini API trả phí.

Phiên bản hiện tại chỉ có một người dùng/admin. VPS, mobile và multi-user chưa nằm trong phạm vi triển khai hiện tại.

## Luồng mong muốn

```text
ChatGPT Plus lập kế hoạch
        ↓
Gemini Pro review
        ↓
Codex nhận kế hoạch cuối và triển khai
        ↓
Git diff + test + kết quả được lưu
        ↓
ChatGPT/Gemini đọc lại qua Task Ledger và MCP
```

Khi Codex account A hết limit, hệ thống tạo handoff capsule, giữ nguyên project/chat/context và đề xuất account B còn hạn mức để tiếp tục.

## Giới hạn cần nhớ

- ChatGPT Plus không có headless API chính thức để dashboard tự gửi prompt như OpenAI API. Vì vậy phải kiểm tra đúng ChatGPT surface hỗ trợ MCP/Plugin.
- MCP chia sẻ context và trạng thái; không chuyển quyền sở hữu native conversation giữa các account.
- Gemini có thể được nghiên cứu qua Gemini CLI chính thức ở chế độ non-interactive, nhưng không được lấy/piggyback OAuth token vào client tự chế.
- Không mặc định coi quota Gemini Pro consumer và quota Gemini CLI là một.
- API pipeline vẫn tồn tại nhưng là chế độ nâng cao, mặc định tắt; không được bật hoặc thêm API key nếu người dùng chưa yêu cầu.
- Không dùng proxy hoặc kỹ thuật né rate limit/detection.

## Các thành phần đã có

- `server.mjs`: HTTP server local, account/project/chat/job, Codex CLI, limit, handoff, planning modes và chuyển task subscription sang Codex.
- `lib/planning-pipeline.mjs`: tạo context pack, lọc secret, đọc Git/file liên quan, tạo prompt GPT/Gemini/Codex.
- `lib/subscription-task-store.mjs`: kho task atomic trong `.data/subscription-tasks`.
- `mcp-server.mjs`: MCP STDIO server, không cần dependency ngoài.
- `lib/project-memory.mjs`: ghi `CURRENT.md`, `HISTORY.md`, `AI_USAGE.json`, `PLAN_CURRENT.md`, `PLANS/*.md`.
- `lib/store.mjs`: state account/project/chat/provider; planning mode mặc định là `subscription`.
- `public/index.html`, `public/app.js`, `public/styles.css`: giao diện kiểu Codex, subscription workflow mặc định, API nâng cao ẩn trong mục tùy chọn.
- `README.md`: hướng dẫn chạy dashboard và cấu hình MCP.

## MCP tools

`mcp-server.mjs` cung cấp:

- `workspace_get_next_planning_task`
- `workspace_save_gpt_plan`
- `workspace_get_next_review_task`
- `workspace_save_gemini_review`
- `workspace_get_task_status`

Trạng thái task chính:

```text
awaiting_gpt → awaiting_gemini → ready_for_codex → running → completed
```

## Cấu hình MCP hiện tại

Người dùng đã mở ChatGPT Desktop → Plugin → MCP → Add và cấu hình dự kiến:

```text
Tên: ai-workspace
Loại: STDIO
Command: node
Argument:
C:\Users\VHC\OneDrive\Máy tính\Code\ai-workspace-manager\mcp-server.mjs

Environment key: AI_WORKSPACE_DATA_DIR
Environment value:
C:\Users\VHC\OneDrive\Máy tính\Code\ai-workspace-manager\.data

Working directory:
C:\Users\VHC\OneDrive\Máy tính\Code\ai-workspace-manager
```

Cần xác minh tiếp bằng `codex mcp list`, sau đó kiểm tra `ai-workspace` đang bật. Chưa được coi là thành công hoàn toàn cho đến khi gọi thử `workspace_get_next_planning_task` trong ChatGPT surface phù hợp.

## Account đã kiểm tra

Tài khoản Codex hiện đăng nhập trên máy là gói Plus. Tại lần đo gần nhất còn khoảng 17% hạn mức, đã dùng 83%, reset khoảng 19:50 ngày 08/08/2026 theo giờ Việt Nam. Đây chỉ là snapshot tại thời điểm kiểm tra; phải đo lại trước khi kết luận.

Không ghi email, password, OTP, cookie, session token hoặc API key vào file này.

## Việc cần làm tiếp

1. Đọc `git status`, bảo toàn toàn bộ thay đổi hiện tại.
2. Chạy `codex mcp list` và xác nhận `ai-workspace`.
3. Chạy dashboard local bằng `npm start`.
4. Tạo project/chat test, gửi một task ở mode `subscription`.
5. Gọi `workspace_get_next_planning_task` từ ChatGPT và lưu plan bằng `workspace_save_gpt_plan`.
6. Xác nhận task chuyển sang `awaiting_gemini`.
7. Kiểm tra Gemini CLI chính thức: đăng nhập Google, chạy `gemini -p ... --output-format json`, xác định quota/model thực tế.
8. Nếu Gemini CLI chạy ổn, thêm adapter subscription chạy nền; không piggyback OAuth.
9. Nếu ChatGPT Work/Chat không gọi được MCP, nghiên cứu đóng gói thành plugin cá nhân hoặc ghi rõ giới hạn surface.
10. Chỉ sau khi pipeline thật chạy mới tiếp tục chỉnh UI hoặc VPS.

## Kiểm tra đã đạt

- `npm run check` đã đạt.
- `node --check server.mjs` đã đạt.
- `node --check public/app.js` đã đạt.
- `node --check mcp-server.mjs` đã đạt.
- `git diff --check` không có lỗi nội dung.
- MCP smoke test `initialize` và `tools/list` đã đạt.
- Kho task đã được test qua các bước GPT → Gemini → Codex.

Browser visual QA chưa chạy được vì phiên kiểm thử trước không có browser control khả dụng. Không được ghi nhận là đã kiểm tra giao diện thật nếu chưa chạy lại.

## Lệnh chạy

```powershell
npm start
```

Dashboard mặc định tại `http://127.0.0.1:4320`.

Self-check:

```powershell
npm run check
```

