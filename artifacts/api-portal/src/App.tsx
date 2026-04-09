import { useState, useEffect, useCallback } from "react";

const BG = "hsl(222, 47%, 11%)";
const BG_CARD = "hsl(222, 47%, 15%)";
const BG_CODE = "hsl(222, 47%, 8%)";
const BORDER = "hsl(222, 30%, 22%)";
const TEXT = "hsl(210, 40%, 96%)";
const TEXT_DIM = "hsl(215, 20%, 65%)";
const TEXT_MUTED = "hsl(215, 15%, 50%)";
const GREEN = "hsl(142, 71%, 45%)";
const RED = "hsl(0, 72%, 51%)";
const BLUE = "hsl(217, 91%, 60%)";
const PURPLE = "hsl(263, 70%, 58%)";
const ORANGE = "hsl(25, 95%, 53%)";
const GRAY_BADGE = "hsl(215, 20%, 40%)";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      style={{
        background: copied ? GREEN : "hsl(222, 47%, 20%)",
        color: copied ? "#fff" : TEXT_DIM,
        border: "none",
        padding: "6px 14px",
        borderRadius: 6,
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 500,
        transition: "all 0.2s",
        whiteSpace: "nowrap",
      }}
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function StatusDot({ online }: { online: boolean | null }) {
  const color = online === null ? TEXT_MUTED : online ? GREEN : RED;
  return (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: color,
        boxShadow: online ? `0 0 8px ${color}, 0 0 16px ${color}40` : "none",
        marginRight: 8,
      }}
    />
  );
}

const MODELS = [
  { id: "gpt-5.2", provider: "OpenAI" },
  { id: "gpt-5-mini", provider: "OpenAI" },
  { id: "gpt-5-nano", provider: "OpenAI" },
  { id: "o4-mini", provider: "OpenAI" },
  { id: "o3", provider: "OpenAI" },
  { id: "claude-opus-4-6", provider: "Anthropic" },
  { id: "claude-sonnet-4-6", provider: "Anthropic" },
  { id: "claude-haiku-4-5", provider: "Anthropic" },
];

const ENDPOINTS = [
  {
    method: "GET",
    path: "/v1/models",
    desc: "List all available models",
    type: "both",
  },
  {
    method: "POST",
    path: "/v1/chat/completions",
    desc: "OpenAI-compatible chat completions with tool calling support",
    type: "OpenAI",
  },
  {
    method: "POST",
    path: "/v1/messages",
    desc: "Native Anthropic Messages API with streaming support",
    type: "Anthropic",
  },
];

const STEPS = [
  {
    title: "Add Provider",
    desc: 'Open CherryStudio Settings, go to "Model Provider", click "Add Provider" and give it a name.',
  },
  {
    title: "Configure Connection",
    desc: "Set the API URL to your Base URL shown above. Set the API Key to your PROXY_API_KEY. Note: You can select either OpenAI or Anthropic as the provider type -- both work through this proxy.",
  },
  {
    title: "Add Models",
    desc: "Click the Models section, then manually add the model IDs listed below (e.g. gpt-5.2, claude-sonnet-4-6).",
  },
  {
    title: "Start Chatting",
    desc: "Select your configured provider and one of the models, then start a new conversation.",
  },
];

function App() {
  const [online, setOnline] = useState<boolean | null>(null);
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  useEffect(() => {
    fetch("/api/healthz")
      .then((r) => {
        setOnline(r.ok);
      })
      .catch(() => setOnline(false));
  }, []);

  const curlExample = `curl ${baseUrl}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "gpt-5.2",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'`;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: BG,
        color: TEXT,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      {/* Header */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 32px",
          borderBottom: `1px solid ${BORDER}`,
          background: BG_CARD,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke={BLUE}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
          </svg>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>
            AI Proxy API
          </h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", fontSize: 14 }}>
          <StatusDot online={online} />
          <span style={{ color: online ? GREEN : online === null ? TEXT_MUTED : RED }}>
            {online === null ? "Checking..." : online ? "Online" : "Offline"}
          </span>
        </div>
      </header>

      <main style={{ maxWidth: 900, margin: "0 auto", padding: "32px 24px" }}>
        {/* Connection Details */}
        <section style={{ marginBottom: 40 }}>
          <h2
            style={{
              fontSize: 16,
              fontWeight: 600,
              marginBottom: 16,
              textTransform: "uppercase",
              letterSpacing: 1,
              color: TEXT_DIM,
            }}
          >
            Connection Details
          </h2>
          <div
            style={{
              background: BG_CARD,
              border: `1px solid ${BORDER}`,
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            {[
              { label: "Base URL", value: baseUrl },
              {
                label: "Auth Header",
                value: "Authorization: Bearer YOUR_API_KEY",
              },
            ].map((item, i) => (
              <div
                key={item.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "16px 20px",
                  borderBottom:
                    i === 0 ? `1px solid ${BORDER}` : "none",
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: 12,
                      color: TEXT_MUTED,
                      marginBottom: 4,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                    }}
                  >
                    {item.label}
                  </div>
                  <code
                    style={{
                      fontSize: 14,
                      color: TEXT,
                      fontFamily: "monospace",
                    }}
                  >
                    {item.value}
                  </code>
                </div>
                <CopyButton text={item.value} />
              </div>
            ))}
          </div>
        </section>

        {/* API Endpoints */}
        <section style={{ marginBottom: 40 }}>
          <h2
            style={{
              fontSize: 16,
              fontWeight: 600,
              marginBottom: 16,
              textTransform: "uppercase",
              letterSpacing: 1,
              color: TEXT_DIM,
            }}
          >
            API Endpoints
          </h2>
          <div
            style={{
              background: BG_CARD,
              border: `1px solid ${BORDER}`,
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            {ENDPOINTS.map((ep, i) => (
              <div
                key={ep.path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "16px 20px",
                  borderBottom:
                    i < ENDPOINTS.length - 1
                      ? `1px solid ${BORDER}`
                      : "none",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      background:
                        ep.method === "GET" ? GREEN : PURPLE,
                      color: "#fff",
                      padding: "3px 10px",
                      borderRadius: 4,
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: 0.5,
                      flexShrink: 0,
                    }}
                  >
                    {ep.method}
                  </span>
                  <code
                    style={{
                      fontSize: 14,
                      color: TEXT,
                      fontFamily: "monospace",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {ep.path}
                  </code>
                  <span
                    style={{
                      background:
                        ep.type === "OpenAI"
                          ? BLUE
                          : ep.type === "Anthropic"
                            ? ORANGE
                            : GRAY_BADGE,
                      color: "#fff",
                      padding: "2px 8px",
                      borderRadius: 4,
                      fontSize: 11,
                      fontWeight: 600,
                      flexShrink: 0,
                    }}
                  >
                    {ep.type === "both" ? "OpenAI + Anthropic" : ep.type}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 13, color: TEXT_DIM }}>{ep.desc}</span>
                  <CopyButton text={`${baseUrl}${ep.path}`} />
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Available Models */}
        <section style={{ marginBottom: 40 }}>
          <h2
            style={{
              fontSize: 16,
              fontWeight: 600,
              marginBottom: 16,
              textTransform: "uppercase",
              letterSpacing: 1,
              color: TEXT_DIM,
            }}
          >
            Available Models
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 12,
            }}
          >
            {MODELS.map((m) => (
              <div
                key={m.id}
                style={{
                  background: BG_CARD,
                  border: `1px solid ${BORDER}`,
                  borderRadius: 10,
                  padding: "14px 18px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <code
                  style={{
                    fontSize: 14,
                    fontFamily: "monospace",
                    color: TEXT,
                  }}
                >
                  {m.id}
                </code>
                <span
                  style={{
                    background: m.provider === "OpenAI" ? BLUE : ORANGE,
                    color: "#fff",
                    padding: "2px 8px",
                    borderRadius: 4,
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  {m.provider}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* CherryStudio Setup Guide */}
        <section style={{ marginBottom: 40 }}>
          <h2
            style={{
              fontSize: 16,
              fontWeight: 600,
              marginBottom: 16,
              textTransform: "uppercase",
              letterSpacing: 1,
              color: TEXT_DIM,
            }}
          >
            CherryStudio Setup Guide
          </h2>
          <div
            style={{
              background: BG_CARD,
              border: `1px solid ${BORDER}`,
              borderRadius: 12,
              padding: "24px",
            }}
          >
            {STEPS.map((step, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 16,
                  marginBottom: i < STEPS.length - 1 ? 24 : 0,
                  alignItems: "flex-start",
                }}
              >
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: "50%",
                    background: `linear-gradient(135deg, ${BLUE}, ${PURPLE})`,
                    color: "#fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 14,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {i + 1}
                </div>
                <div>
                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 600,
                      color: TEXT,
                      marginBottom: 4,
                    }}
                  >
                    {step.title}
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      color: TEXT_DIM,
                      lineHeight: 1.5,
                    }}
                  >
                    {step.desc}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Quick Test */}
        <section style={{ marginBottom: 40 }}>
          <h2
            style={{
              fontSize: 16,
              fontWeight: 600,
              marginBottom: 16,
              textTransform: "uppercase",
              letterSpacing: 1,
              color: TEXT_DIM,
            }}
          >
            Quick Test
          </h2>
          <div
            style={{
              background: BG_CODE,
              border: `1px solid ${BORDER}`,
              borderRadius: 12,
              position: "relative",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "12px 16px",
                borderBottom: `1px solid ${BORDER}`,
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  color: TEXT_MUTED,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                curl
              </span>
              <CopyButton text={curlExample} />
            </div>
            <pre
              style={{
                padding: "16px 20px",
                margin: 0,
                fontSize: 13,
                lineHeight: 1.6,
                overflowX: "auto",
                fontFamily:
                  '"Fira Code", "JetBrains Mono", "Cascadia Code", monospace',
              }}
            >
              <span style={{ color: GREEN }}>curl</span>{" "}
              <span style={{ color: "hsl(40, 95%, 64%)" }}>
                {baseUrl}/v1/chat/completions
              </span>{" "}
              <span style={{ color: TEXT_MUTED }}>\</span>
              {"\n"}
              {"  "}
              <span style={{ color: BLUE }}>-H</span>{" "}
              <span style={{ color: "hsl(40, 95%, 64%)" }}>
                "Content-Type: application/json"
              </span>{" "}
              <span style={{ color: TEXT_MUTED }}>\</span>
              {"\n"}
              {"  "}
              <span style={{ color: BLUE }}>-H</span>{" "}
              <span style={{ color: "hsl(40, 95%, 64%)" }}>
                "Authorization: Bearer YOUR_API_KEY"
              </span>{" "}
              <span style={{ color: TEXT_MUTED }}>\</span>
              {"\n"}
              {"  "}
              <span style={{ color: BLUE }}>-d</span>{" "}
              <span style={{ color: "hsl(40, 95%, 64%)" }}>{"'"}</span>
              <span style={{ color: TEXT_DIM }}>{"{"}</span>
              {"\n"}
              {"    "}
              <span style={{ color: BLUE }}>"model"</span>
              <span style={{ color: TEXT_DIM }}>: </span>
              <span style={{ color: GREEN }}>"gpt-5.2"</span>
              <span style={{ color: TEXT_DIM }}>,</span>
              {"\n"}
              {"    "}
              <span style={{ color: BLUE }}>"messages"</span>
              <span style={{ color: TEXT_DIM }}>: [</span>
              {"\n"}
              {"      "}
              <span style={{ color: TEXT_DIM }}>{"{"}</span>
              <span style={{ color: BLUE }}>"role"</span>
              <span style={{ color: TEXT_DIM }}>: </span>
              <span style={{ color: GREEN }}>"user"</span>
              <span style={{ color: TEXT_DIM }}>, </span>
              <span style={{ color: BLUE }}>"content"</span>
              <span style={{ color: TEXT_DIM }}>: </span>
              <span style={{ color: GREEN }}>"Hello!"</span>
              <span style={{ color: TEXT_DIM }}>{"}"}</span>
              {"\n"}
              {"    "}
              <span style={{ color: TEXT_DIM }}>]</span>
              {"\n"}
              {"  "}
              <span style={{ color: TEXT_DIM }}>{"}"}</span>
              <span style={{ color: "hsl(40, 95%, 64%)" }}>{"'"}</span>
            </pre>
          </div>
        </section>

        {/* Footer */}
        <footer
          style={{
            textAlign: "center",
            padding: "32px 0",
            borderTop: `1px solid ${BORDER}`,
            color: TEXT_MUTED,
            fontSize: 13,
          }}
        >
          Built with Express + OpenAI SDK + Anthropic SDK. Dual-compatible proxy
          supporting both OpenAI and Anthropic API formats with full tool calling
          and streaming support.
        </footer>
      </main>
    </div>
  );
}

export default App;
