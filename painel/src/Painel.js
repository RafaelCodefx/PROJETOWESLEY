// Painel.js  
import React, { useState, useEffect, useRef } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import logo from './assets/logo.jpeg';





function decodeJwtPayload(token) {
  try {
    const [, payloadBase64] = token.split('.');
    const decoded = atob(payloadBase64);               // decodifica do base64
    return JSON.parse(decoded);                         // transforma em objeto
  } catch {
    return null;
  }
}


function useMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 480);
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 480);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  return isMobile;
}

// Componente de Popup do QR Code
function QrCodePopup({ open, onClose, numeroPainel }) {
  const [qr, setQr] = useState(null);

  useEffect(() => {
    if (!open) return;
    setQr(null);

    const fetchQr = async () => {
      try {
        const res = await axios.get(
          `http://localhost:3335/api/whatsapp-qr?numero=${numeroPainel}`
        );
        setQr(res.data.qr);
      } catch {
        setQr(null);
      }
    };

    fetchQr();
    const timer = setInterval(fetchQr, 2500);
    return () => clearInterval(timer);
  }, [open, numeroPainel]);

  if (!open) return null;

  return (
    <div className="qr-modal-overlay">
      <div className="qr-modal">
        <button className="close-btn" onClick={onClose}>×</button>
        <h2>Conecte o WhatsApp</h2>
        <div style={{ minHeight: 200, display: "flex", justifyContent: "center", alignItems: "center" }}>
          {qr
            ? <img src={qr} alt="QR Code WhatsApp" style={{ width: 220, height: 220 }} />
            : <span>Carregando QR Code...</span>
          }
        </div>
        <div style={{ fontSize: 14, color: "#888", marginTop: 16, textAlign: "center" }}>
          Abra o WhatsApp, clique em <b>Menu {'>'} Aparelhos conectados</b> e escaneie o QR Code.
        </div>
      </div>
      <style>{`
        .qr-modal-overlay {
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0,0,0,0.55);
          z-index: 99999;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .qr-modal {
          background: #23243a;
          padding: 30px 26px 18px 26px;
          border-radius: 20px;
          box-shadow: 0 8px 40px #0007;
          position: relative;
          min-width: 310px;
          max-width: 95vw;
          color: #fff;
        }
        .close-btn {
          position: absolute;
          top: 10px; right: 14px;
          font-size: 26px;
          background: none;
          border: none;
          color: #fff;
          cursor: pointer;
        }
        @media (max-width: 500px) {
          .qr-modal {
            min-width: 90vw;
            padding: 20px 6vw 12px 6vw;
          }
        }
      `}</style>
    </div>
  );
}

function Painel() {
  const navigate = useNavigate();
  const isMobile = useMobile();
  const chatRef = useRef(null);
  

  const [input, setInput] = useState("");
  const [chat, setChat] = useState([]);
  const [loading, setLoading] = useState(false);
  const [relatorios, setRelatorios] = useState([]);
  const [ultimosClientes, setUltimosClientes] = useState([]);
  const [ultimasCobrancas, setUltimasCobrancas] = useState([]);
  const [input2, setInput2] = useState("");
  const [asaasToken, setAsaasToken] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [savedMsg, setSavedMsg] = useState("");
  const [qrPopup, setQrPopup] = useState(false);
  const [eventos, setEventos] = useState([])




  // Estado para receber o número logado pelo bot WhatsApp
  const [whatsappNumero, setWhatsappNumero] = useState(null);

  // Pega o objeto auth (token, nome e número) do localStorage
// 1) pegar auth do localStorage (tem apenas { token: "xxxxx" })
  const auth = JSON.parse(localStorage.getItem('auth') || 'null');
  const token = auth?.token || "";

  // 2) decodificar o payload para extrair nome e número
  const payload = token ? decodeJwtPayload(token) : null;
  const nomeUsuario = payload?.nome || "";
  const numeroPainel = payload?.numero || "";

console.log("auth bruto:", auth);
console.log("payload decodificado:", payload);
console.log("numeroPainel:", numeroPainel);



function formatar_e_salvar_base_conhecimento(file) {
  const auth = JSON.parse(localStorage.getItem('auth') || '{}');
  const token = auth?.token;

  if (!token) {
    alert("Token de autenticação não encontrado.");
    return;
  }

  const formData = new FormData();
  formData.append("arquivo", file);

  fetch("http://localhost:3001/api/formatarconh", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: formData
  })
    .then(res => res.json())
    .then(data => {
      if (data.ok) {
        alert("✅ Base de conhecimento formatada e salva com sucesso!");
        console.log("Arquivo salvo:", data.arquivo);
      } else {
        alert("❌ Falha ao salvar a base.");
        console.error(data.msg);
      }
    })
    .catch(err => {
      console.error("Erro ao enviar o arquivo:", err);
      alert("❌ Erro inesperado ao enviar.");
    });
}




useEffect(() => {
  if (!token) {
    localStorage.removeItem("auth");
    return navigate("/login");
  }

  // Decodifica payload para extrair exp (timestamp em segundos)
  const payload = decodeJwtPayload(token);

  // Se JWT malformado ou sem exp, trate como inválido
  if (!payload || !payload.exp) {
    localStorage.removeItem("auth");
    return navigate("/login");
  }

  // Verifica se expirou: payload.exp é em segundos
  const timestampExp = payload.exp * 1000; // converte para milissegundos
  if (Date.now() > timestampExp) {
    localStorage.removeItem("auth");
    return navigate("/login");
  }

  // (Opcional) também pode checar com o backend se o token ainda é aceito:
  // axios.get("/api/me", { headers: { Authorization: `Bearer ${token}` } })
  //   .catch(() => {
  //     localStorage.removeItem("auth");
  //     navigate("/login");
  //   });
}, [token, navigate]);


useEffect(() => {
  const listarEvento = async () => {
    if (!token) return;
    try {
      const res = await axios.get(
        "http://localhost:3001/api/google/listar-eventos2",
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setEventos(res.data.eventos || []);
      console.log("Eventos retornados:", res.data.eventos);
    } catch (err) {
      console.error("Erro ao buscar eventos:", err.response?.data || err.message);
    }
  };

  listarEvento();
}, [token]); 



  //console.log("numero do painel: ", numeroPainel)
   // ─── 1) Polling para CHECAR /api/me e ver se bate com numeroPainel ─────────────
   useEffect(() => {
    if (!token || !numeroPainel) return;

    const checarWhats = async () => {
      try {
        const resp = await axios.get(
          `http://localhost:3335/api/me?numero=${numeroPainel}`
        );        
        setWhatsappNumero(resp.data.numero);
        console.log("Bot retornou:", resp.data.numero);
      } catch {
        // silencioso
      }
    };

    checarWhats();
    const interval = setInterval(checarWhats, 2000);
    return () => clearInterval(interval);
  }, [token, numeroPainel]);

  // ─── 2) Enviar { numero, token } para o bot (em vez de apenas { token }) ───────
  useEffect(() => {
    if (!token) return;
 
    // Exemplo de chamada para /api/receive-token (altere para o endpoint real depois)
    axios.post(
     "http://localhost:3335/api/receive-token",
      { token },
      { headers: { Authorization: `Bearer ${token}` } }
    )
    .then(() => {
      console.log("Token enviado com sucesso ao endpoint /receive-token");
    })
    .catch(err => {
      console.error("Erro ao enviar token:", err);
    });
    if (!token || !numeroPainel) return; 
    // Agora enviamos { numero, token } para o bot
    axios.post(
      "http://localhost:3335/api/receive-token",
      {
        numero: numeroPainel,  // ex: "5511912345678"
        token: token           // o JWT do painel
      },
      { headers: { Authorization: `Bearer ${token}` } }
    )
    .then(() => {
      console.log("Número e token enviados com sucesso ao /api/receive-token");
    })
    .catch(err => {
      console.error("Erro ao enviar número+token:", err);
    });
  }, [token, numeroPainel]);

  // ────────────────────────────────────────────────────────────────────────────


  // ─── 2) Buscar configurações do painel (API) ────────────────────────────────────
  useEffect(() => {
    if (!token) return;

    axios.get("http://localhost:3001/api/get-config", {
      headers: { Authorization: `Bearer ${token}` }
    })
    .then(res => {
      if (res.data) {
        setInput2(res.data.customInstructions || "");
        setAsaasToken(res.data.asaasKey || "");
        setOpenaiKey(res.data.openaiKey || "");
        setGoogleClientId(res.data.googleClientId || "");
        setGoogleClientSecret(res.data.googleClientSecret || "");
      }
    })
    .catch(err => {
      console.log("Erro: ", err);
    });

   
  }, [token]);

  // ─── 3) Buscar dados do painel (relatórios, clientes, cobranças) ────────────────
  useEffect(() => {
    if (!token) return;

    const fetchPainel = async () => {
      try {
        const res = await axios.get("http://localhost:3001/api/painel", {
          headers: { Authorization: `Bearer ${token}` }
        });
        setRelatorios([
          { id: 1, descricao: `Total de clientes: ${res.data.totalClientes}` },
          { id: 2, descricao: `Total de cobranças: ${res.data.totalCobrancas}` },
          { id: 3, descricao: `Total recebido: R$ ${res.data.totalRecebido.toFixed(2)}` },
          { id: 4, descricao: `Total pendente: R$ ${res.data.totalPendente.toFixed(2)}` },
          { id: 5, descricao: `Total vencido: R$ ${res.data.totalVencido.toFixed(2)}` },
        ]);
        setUltimosClientes(res.data.ultimosClientes || []);
        setUltimasCobrancas(res.data.ultimasCobrancas || []);
      } catch {
        setRelatorios([{ id: 0, descricao: "Erro ao carregar relatórios!" }]);
        setUltimosClientes([]);
        setUltimasCobrancas([]);
      }
    };
    fetchPainel();
  }, [token]);

  // ─── 4) Checa status do bot WhatsApp periodicamente ─────────────────────────────
  const [botOnline, setBotOnline] = useState(false);
  useEffect(() => {
    if (!numeroPainel) return;
  
    const fetchStatus = async () => {
      try {
        const res = await axios.get(
          `http://localhost:3335/api/whatsapp-status?numero=${numeroPainel}`
        );
        setBotOnline(res.data.online);
      } catch {
        setBotOnline(false);
      }
    };
  
    fetchStatus();
    const timer = setInterval(fetchStatus, 4000);
    return () => clearInterval(timer);
  }, [numeroPainel]);


  
/* const obterUrlAuthGoogle = async () => {
  const resp = await axios.get('http://localhost:3001/api/google/get-auth-url', {
    headers: { Authorization: `Bearer ${token}` }
  });
  window.location.href = resp.data.url; // redireciona para a tela de consentimento Google
};*/

  console.log(auth)
  //console.log("WhatsappNumero e numeroPainel: ", whatsappNumero, numeroPainel)

  // ─── 5) Envio de mensagem ao bot via webhook ───────────────────────────────────
  const handleSend = async (e) => {
    e.preventDefault();
    if (!input.trim()) return;
  
    setLoading(true);
    setChat(prev => [...prev, { type: "user", text: input }]);
  
    try {
      const res = await axios.post(
        "http://localhost:8003/api/webhook",
        { question: input },                           
        {
          headers: {
            "Content-Type": "application/json",        
            Authorization: `Bearer ${token}`
          }
        }
      );
      const resposta = res.data.answer;
      setChat(prev => [...prev, { type: "bot", text: resposta }]);
    } catch (err) {
      console.error("Erro completo:", err);
      console.error("Resposta do backend:", err?.response?.data || err.message);
    
      setChat(prev => [
        ...prev,
        { type: "bot", text: "❌ Erro ao chamar o serviço. Tente novamente." }
      ]);
    }
    setInput("")
    setLoading(false)
  }
    

  
  const handleSaveEConectarGoogle = async (e) => {
    e.preventDefault();
    if (!token) return setSavedMsg("Você não está autenticado.");
  
    try {
      // 1) Primeiro, salva os IDs/Secrets no backend
      await axios.post(
        "http://localhost:3001/api/save-config",
        {
          customInstructions: input2,
          asaasKey: asaasToken,
          openaiKey: openaiKey,
          googleClientId: googleClientId,
          googleClientSecret: googleClientSecret
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSavedMsg("Configurações salvas!");
  
      // 2) Em seguida, redireciona para o consent do Google
      const resp = await axios.get('http://localhost:3001/api/google/get-auth-url', {
        headers: { Authorization: `Bearer ${token}` }
      });
      window.location.href = resp.data.url;
  
    } catch (err) {
      setSavedMsg("Erro ao salvar configurações!");
      console.error(err);
    }
    setTimeout(() => setSavedMsg(""), 1600);
  };



  // ─── 6) Salvar configurações de Integrações ───────────────────────────────────
    const handleSave = async (e) => {
    e.preventDefault();
    if (!token) return setSavedMsg("Você não está autenticado.");

    try {
      await axios.post(
        "http://localhost:3001/api/save-config",
        {
          customInstructions: input2,
          asaasKey: asaasToken,
          openaiKey: openaiKey,
          googleClientId: googleClientId,
          googleClientSecret: googleClientSecret
        },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      setSavedMsg("Configurações salvas!");
    } catch (err) {
      setSavedMsg("Erro ao salvar configurações!");
    }
    setTimeout(() => setSavedMsg(""), 1600);
  };



  // ─── 7) Auto-scroll do chat ────────────────────────────────────────────────────
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [chat]);

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(120deg, #23243a 0%, #343652 100%)",
      fontFamily: "Orbitron, Roboto Mono, sans-serif",
      width: "100vw"
    }}>
 <header
  style={{
    width: "100%",
    background: "linear-gradient(145deg, #1f2333, #252b3f)",
    color: "#fff",
    padding: isMobile ? "14px 1rem" : "26px 2rem",
    display: "flex",
    flexDirection: isMobile ? "column" : "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: "1px solid #2e3147",
    boxShadow: "0 4px 32px rgba(14, 22, 44, 0.25)",
    position: "sticky",
    top: 0,
    zIndex: 200,
    backdropFilter: "blur(8px)"
  }}
>
  <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 12 : 20 }}>
    <img
      src={logo}
      alt="Logo"
      style={{
        width: isMobile ? 36 : 50,
        height: isMobile ? 36 : 50,
        borderRadius: "50%",
        boxShadow: "0 4px 12px rgba(100, 255, 218, 0.3)",
        transform: "scale(1.01)",
        transition: "transform 0.3s ease-in-out"
      }}
      onMouseEnter={e => (e.currentTarget.style.transform = "scale(1.07)")}
      onMouseLeave={e => (e.currentTarget.style.transform = "scale(1.01)")}
    />

    <div>
      <span style={{
        fontFamily: "Orbitron, sans-serif",
        fontSize: isMobile ? 16 : 22,
        fontWeight: 700,
        color: "#7df9ff", // cor que remete à IA, movimento e estímulo
        letterSpacing: "1.2px",
        textShadow: "0 0 6px rgba(125, 249, 255, 0.4)"
      }}>
        EVA • IA
      </span>
      <div style={{
        fontSize: isMobile ? 13 : 15,
        color: "#e2e8f0",
        fontWeight: 400
      }}>
        Olá, <b style={{ color: "#a0f0d0" }}>{nomeUsuario}</b> 👋
      </div>
    </div>
  </div>



  <button
    onClick={() => {
      localStorage.removeItem("token");
      window.location.href = "/";
    }}
    style={{
      padding: "9px 40px",
      borderRadius: "8px",
      background: "linear-gradient(135deg, #7f5af0, #2cb67d)",
      color: "#fff",
      fontWeight: 600,
      fontSize: "14px",
      border: "none",
      cursor: "pointer",
      boxShadow: "0 2px 12px rgba(127, 90, 240, 0.3)",
      transition: "all 0.3s ease-in-out"
    }}
    onMouseEnter={e => {
      e.currentTarget.style.filter = "brightness(1.15)";
    }}
    onMouseLeave={e => {
      e.currentTarget.style.filter = "brightness(1)";
    }}
  >
    Sair
  </button>
</header>


<div style={{
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexDirection:'column',
  padding: "14px",
  borderRadius: "12px",
  backgroundColor: "transparent",
  backdropFilter: "blur(4px)",

  transition: "all 0.3s ease-in-out"
}}>
  <div style={{
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 8,
  padding: "12px 18px",
  border: "2px dashed #7df9ff55",
  borderRadius: 16,
  background: "linear-gradient(145deg, #1f2333, #252b3f)",
  color: "#7df9ff",
  width: "fit-content",
  margin: "0 auto",
  cursor: "pointer",
  transition: "all 0.3s ease-in-out"
}}
  onMouseEnter={e => e.currentTarget.style.borderColor = "#2cb67d"}
  onMouseLeave={e => e.currentTarget.style.borderColor = "#7df9ff55"}
>
  <input
    id="upload-arquivo"
    type="file"
    accept=".txt"
    style={{ display: "none" }}
    onChange={e => {
      if (e.target.files.length > 0) {
        formatar_e_salvar_base_conhecimento(e.target.files[0]);
      }
    }}
  />
  
  <label htmlFor="upload-arquivo" style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
    <svg
      width="42"
      height="42"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#7df9ff"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transition: "transform 0.2s ease, stroke 0.2s ease",
        filter: "drop-shadow(0 0 6px #7df9ff44)"
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = "scale(1.2)";
        e.currentTarget.style.stroke = "#2cb67d";
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = "scale(1)";
        e.currentTarget.style.stroke = "#7df9ff";
      }}
    >
      <path d="M16 16l-4-4-4 4" />
      <path d="M12 12v9" />
      <path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 104 16.3" />
    </svg>
    <span style={{
      marginTop: 6,
      fontSize: 15,
      color: "#e2e8f0",
      fontWeight: 500,
      textAlign: "center"
    }}>
      Fazer upload da base<br />de exemplos de conversas (.txt)
    </span>
  </label>
</div>


</div>


      {/* Status do Bot / Confirmação de número */}
      <div style={{
  textAlign: "center",
  margin: "16px 0"
}}>
  {whatsappNumero === numeroPainel && botOnline ? (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 10,
      padding: "12px 28px",
      borderRadius: 14,
      background: "linear-gradient(90deg, #059669 60%, #22d3ee 100%)",
      color: "#fff",
      fontWeight: "bold",
      fontSize: 19,
      boxShadow: "0 2px 8px #1b243860",
      border: "none",
      position: "relative"
    }}>
      <span className="pulse-dot"></span>
      WhatsApp online
    </div>
  ) : (
    <div style={{ color: "#e11d48", fontSize: 16 }}>
      {whatsappNumero
        ? "❌ Número não confere com o painel"
        : "⌛ Aguardando login no WhatsApp..."}
    </div>
  )}
  <style>{`
    .pulse-dot {
      display: inline-block;
      width: 16px;
      height: 16px;
      background: #22c55e;
      border-radius: 50%;
      margin-right: 7px;
      border: 2px solid #fff;
      box-shadow: 0 0 8px #22c55e55;
      position: relative;
    }
    .pulse-dot::after {
      content: "";
      position: absolute;
      left: 50%; top: 50%;
      transform: translate(-50%, -50%);
      width: 24px; height: 24px;
      border-radius: 50%;
      background: rgba(34, 197, 94, 0.3);
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0% { transform: translate(-50%, -50%) scale(1);}
      70% { transform: translate(-50%, -50%) scale(1.8);}
      100% { opacity: 0;}
    }
  `}</style>
</div>




      {/* Botão para abrir QR Code enquanto não confirmado */}
      {whatsappNumero !== numeroPainel && (
        <div style={{ textAlign: "center", marginBottom: 16 }}>
        <button
        style={{
          background: "linear-gradient(90deg, #38bdf8 60%, #22d3ee 100%)",
          color: "#fff",
          border: "none",
          padding: "12px 32px",
          borderRadius: 14,
          fontWeight: "bold",
          fontSize: 18,
          cursor: "pointer",
          boxShadow: "0 2px 8px #1b243840",
          transition: "background 0.2s, transform 0.1s"
        }}
        onClick={() => setQrPopup(true)}  // <- ADICIONE ESTA LINHA
        onMouseOver={e => e.currentTarget.style.background = "linear-gradient(90deg, #2563eb 40%, #38bdf8 100%)"}
        onMouseOut={e => e.currentTarget.style.background = "linear-gradient(90deg, #38bdf8 60%, #22d3ee 100%)"}
      >
        Conectar WhatsApp
      </button>

          <QrCodePopup 
          open={qrPopup} 
          onClose={() => setQrPopup(false)} 
          numeroPainel={numeroPainel} 
          />
        </div>
      )}

      {/* Estilos responsivos */}
      <style>{`
        .main-grid {
          display: flex;
          flex-wrap: wrap;
          gap: 28px;
          justify-content: center;
          max-width: 1340px;
          margin: 0 auto;
          padding: 34px 12px 18px 12px;
          box-sizing: border-box;
        }
        .sidebar-left, .sidebar-right, .center-panel {
          min-width: 285px;
          max-width: 380px;
          flex: 1 1 320px;
          box-sizing: border-box;
        }
        .center-panel {
          max-width: 470px;
          min-width: 270px;
        }
        @media (max-width: 1100px) {
          .main-grid {
            gap: 18px;
          }
          .sidebar-left, .sidebar-right, .center-panel {
            min-width: 240px;
            max-width: 99vw;
          }
        }
        @media (max-width: 900px) {
          .main-grid {
            flex-direction: column;
            align-items: center;
            padding: 20px 4vw 8px 4vw;
          }
          .sidebar-left, .sidebar-right, .center-panel {
            max-width: 100vw;
            min-width: 180px;
          }
        }
        @media (max-width: 600px) {
          .main-grid {
            flex-direction: column;
            align-items: stretch;
            gap: 10px;
            padding: 8px 0;
          }
          .sidebar-left, .sidebar-right, .center-panel {
            max-width: 100vw;
            min-width: 120px;
            padding-left: 2vw !important;
            padding-right: 2vw !important;
          }
        }
      `}</style>

      <main className="main-grid">
        {/* Sidebar esquerda - Configurações */}
        <aside className="sidebar-left">
          <section style={{
            background: "#212135",
            borderRadius: 18,
            padding: "22px 20px 20px 20px",
            color: "#fff",
            marginBottom: 18,
            boxShadow: "0 6px 36px 0 rgba(26,40,80,0.13)",
            border: "1px solid #272846"
          }}>
            <h3 style={{
              fontWeight: 800,
              fontSize: 21,
              margin: "0 0 16px 0",
              letterSpacing: 1,
              color: "#6ee7b7"
            }}>Configurações</h3>
            <div style={{ marginBottom: 22 }}>
              <label style={{
                fontWeight: 600,
                color: "#6ee7b7",
                fontSize: 16,
                marginBottom: 6,
                display: 'block'
              }}>
                Instruções Personalizadas
              </label>
              <textarea
                placeholder="Exemplo: Sempre responda com simpatia. Chame o cliente pelo primeiro nome. Siga as orientações X, Y, Z..."
                value={input2}
                onChange={e => setInput2(e.target.value)}
                style={{
                  width: '95%',
                  minHeight: 90,
                  fontSize: 15,
                  borderRadius: 10,
                  border: "1px solid #c7d2fe",
                  background: "#191b2b",
                  color: "#f3f6ff",
                  padding: "12px 13px",
                  marginTop: 3,
                  fontFamily: "Orbitron, Roboto Mono, Arial, sans-serif",
                  resize: "vertical",
                  outline: "none",
                  boxShadow: "0 2px 8px rgba(55,65,81,0.04)"
                }}
                disabled={loading}
                autoComplete="off"
                rows={4}
                maxLength={3000}
              />
              <div style={{ color: "#b4ffe6", fontSize: 13, marginTop: 4 }}>
                Escreva dicas e regras para o agente responder do seu jeito. <br />
                (Exemplo: "Use linguagem informal. Nunca diga que é um robô.")
              </div>
            </div>
            <h3 style={{
              fontWeight: 800,
              fontSize: 21,
              margin: "0 0 16px 0",
              letterSpacing: 1,
              color: "#6ee7b7"
            }}>Integrações </h3>
            <form onSubmit={handleSaveEConectarGoogle} autoComplete="off">
              <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
                <legend style={{
                  fontSize: 14,
                  color: "#aaa",
                  fontWeight: 600,
                  marginBottom: 12
                }}>OpenAI API</legend>
                <input
                  type="text"
                  value={openaiKey}
                  onChange={e => setOpenaiKey(e.target.value)}
                  placeholder="OpenAI api key"
                  style={{
                    width: "95%",
                    borderRadius: 9,
                    padding: "10px",
                    border: "1px solid #334155",
                    fontSize: 15,
                    background: "#191b2b",
                    color: "#91ffd7",
                    marginBottom: 18,
                    fontFamily: "Orbitron, monospace"
                  }}
                  autoComplete="off"
                />
              </fieldset>
              <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
                <legend style={{
                  fontSize: 14,
                  color: "#aaa",
                  fontWeight: 600,
                  marginBottom: 12
                }}>Asaas API</legend>
                <input
                  type="text"
                  value={asaasToken}
                  onChange={e => setAsaasToken(e.target.value)}
                  placeholder="Token Asaas"
                  style={{
                    width: "95%",
                    borderRadius: 9,
                    padding: "10px",
                    border: "1px solid #334155",
                    fontSize: 15,
                    background: "#191b2b",
                    color: "#91ffd7",
                    marginBottom: 18,
                    fontFamily: "Orbitron, monospace"
                  }}
                  autoComplete="off"
                />
              </fieldset>
              <button type="submit" onClick={handleSave} style={{
                background: "linear-gradient(90deg, #2dd4bf, #2563eb)",
                color: "#fff",
                border: "none",
                padding: "10px 0",
                borderRadius: 12,
                fontWeight: "bold",
                fontSize: 16,
                width: "100%",
                marginTop: 5,
                cursor: "pointer",
                boxShadow: "0 2px 8px #1b243840"
              }}>
              Salvar
              </button>
              <br></br>
              <br></br>
              <fieldset style={{ border: "none", margin: 0, padding: 0 }}>

              
                <legend style={{
                  fontSize: 14,
                  color: "#aaa",
                  fontWeight: 600,
                  marginBottom: 12
                }}>Google Calendar API</legend>
                <input
                  type="text"
                  value={googleClientId}
                  onChange={e => setGoogleClientId(e.target.value)}
                  placeholder="Client ID"
                  style={{
                    width: "95%",
                    borderRadius: 9,
                    padding: "10px",
                    border: "1px solid #334155",
                    fontSize: 15,
                    background: "#191b2b",
                    color: "#fff7b7",
                    marginBottom: 13,
                    fontFamily: "Orbitron, monospace"
                  }}
                  autoComplete="off"
                />
                <input
                  type="text"
                  value={googleClientSecret}
                  onChange={e => setGoogleClientSecret(e.target.value)}
                  placeholder="Client Secret"
                  style={{
                    width: "95%",
                    borderRadius: 9,
                    padding: "10px",
                    border: "1px solid #334155",
                    fontSize: 15,
                    background: "#191b2b",
                    color: "#fff7b7",
                    marginBottom: 19,
                    fontFamily: "Orbitron, monospace"
                  }}
                  autoComplete="off"
                />
              </fieldset>

              <div style={{ color: "#b4ffe6", fontSize: 13, marginTop: 4 }}>
                REDIRECT_URI: http://localhost:3001/api/google/oauth2callback, - precisa ser idêntica à “Authorized redirect URI” no Console do Google (https://console.cloud.google.com/apis/credentials)
              </div>

              <br></br>
              <button type="submit" style={{
                background: "linear-gradient(90deg, #2dd4bf, #2563eb)",
                color: "#fff",
                border: "none",
                padding: "10px 0",
                borderRadius: 12,
                fontWeight: "bold",
                fontSize: 16,
                width: "100%",
                marginTop: 5,
                cursor: "pointer",
                boxShadow: "0 2px 8px #1b243840"
              }}>
              Conectar Agenda
              </button>
              {savedMsg && (
                alert(savedMsg)
              )}
             {/* {savedMsg && (
                <div style={{
                  color: "#34d399",
                  fontSize: 15,
                  marginTop: 7,
                  textAlign: "center"
                }}>{savedMsg}</div>
              )}
                */}
            </form>
          </section>
        </aside>

        {/* Coluna central - Painel principal */}
        <div className="center-panel" style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          width: "100%"
        }}>
          {/* Relatórios rápidos */}
          <section style={{
            display: "flex",
            gap: 12,
            marginBottom: 18,
            marginTop: 4,
            flexWrap: "wrap",
            justifyContent: "center",
            width: "100%"
          }}>
            {relatorios.map(r => (
              <div key={r.id} style={{
                background: "rgba(255,255,255,0.08)",
                color: "#fff",
                borderRadius: 16,
                padding: "18px 18px",
                minWidth: 140,
                fontSize: 17,
                fontWeight: 600,
                boxShadow: "0 2px 12px 0 rgba(80,80,110,0.09)",
                border: "1px solid #283154",
                marginBottom: 7,
                textAlign: "center",
                flex: "1 1 145px"
              }}>{r.descricao}</div>
            ))}
          </section>

          {/* Chat + Perguntas */}
          <div style={{
            background: "#fff",
            width: "100%",
            maxWidth: 430,
            minHeight: 400,
            borderRadius: 22,
            boxShadow: "0 8px 40px rgba(30,40,80,0.13)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            marginTop: 20,
            marginBottom: 20,
            border: "1px solid #e0e7ef"
          }}>
            <div ref={chatRef} style={{
              flex: 1,
              padding: "26px 16px 14px 16px",
              overflowY: "auto",
              background: "#f8fafc",
              fontSize: 16,
              minHeight: 180
            }}>
              {chat.length === 0 && (
                <div style={{ textAlign: "center", color: "#aaa" }}>
                  <span>
                    {whatsappNumero === numeroPainel
                      ? 'Faça uma pergunta ao agente. Ex: "Como está o pedido?"'
                      : "Aguardando confirmação do WhatsApp..."}
                  </span>
                </div>
              )}
              {chat.map((m, i) => (
                <div key={i} style={{
                  marginBottom: 14,
                  textAlign: m.type === "user" ? "right" : "left"
                }}>
                  <span style={{
                    display: "inline-block",
                    background: m.type === "user" ? "#dbeafe" : "#d1fae5",
                    color: "#23243a",
                    borderRadius: 12,
                    padding: "10px 14px",
                    maxWidth: 240,
                    wordBreak: "break-word"
                  }}>
                    {m.text}
                  </span>
                </div>
              ))}
            </div>
            <form
              style={{
                borderTop: "1px solid #e0e7ef",
                background: "#f8fafc",
                padding: "12px 16px",
                display: "flex",
                gap: 10
              }}
              onSubmit={handleSend}
            >
              <input
                type="text"
                placeholder=" Peça Resumo de conversas ao agente…"
                value={input}
                onChange={e => setInput(e.target.value)}
                style={{
                  flex: 1,
                  fontSize: 16,
                  padding: "10px 16px",
                  borderRadius: 10,
                  border: "1px solid #c7d2fe",
                  outline: "none"
                }}
                disabled={loading || whatsappNumero !== numeroPainel}
              />
              <button
                type="submit"
                style={{
                  background: "#2563eb",
                  color: "#fff",
                  border: "none",
                  padding: "10px 22px",
                  borderRadius: 12,
                  fontWeight: "bold",
                  fontSize: 16,
                  cursor: "pointer",
                  opacity: loading || whatsappNumero !== numeroPainel ? 0.5 : 1,
                  transition: "opacity 0.2s"
                }}
                disabled={loading || whatsappNumero !== numeroPainel}
              >
                {loading ? "..." : "Enviar"}
              </button>
            </form>
          </div>
        </div>

        {/* Sidebar direita */}
        <aside className="sidebar-right">
          <section style={{
            background: "#212135",
            borderRadius: 16,
            padding: "20px 16px 13px 16px",
            color: "#6ee7b7",
            marginBottom: 18,
            boxShadow: "0 2px 10px 0 rgba(80,80,110,0.13)",
            border: "1px solid #283154"
          }}>
            <h3 style={{
              color: "#fff",
              margin: "0 0 12px 0",
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: 1
            }}>Últimos clientes</h3>
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {ultimosClientes.length === 0 && <li style={{ color: "#fff" }}>Nenhum cliente encontrado.</li>}
              {ultimosClientes.map((c, idx) => (
                <li key={c.id || c.cpfCnpj || idx} style={{
                  marginBottom: 7,
                  color: "#e0e6ed",
                  fontWeight: 500,
                  fontSize: 15
                }}>
                  {c.name} {c.email && <span style={{ color: "#eee", fontSize: 13 }}>({c.email})</span>}
                </li>
              ))}
            </ul>
          </section>
          
          <section style={{
            background: "#212135",
            borderRadius: 16,
            padding: "20px 16px 13px 16px",
            color: "#f9fafb",
            boxShadow: "0 2px 10px 0 rgba(80,80,110,0.13)",
            border: "1px solid #283154"
          }}>
            <h3 style={{
              color: "#fff",
              margin: "0 0 12px 0",
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: 1
            }}>Últimas cobranças</h3>
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {ultimasCobrancas.length === 0 && <li>Nenhuma cobrança encontrada.</li>}
              {ultimasCobrancas.map((c, idx) => (
                <li key={c.id || idx} style={{
                  marginBottom: 7,
                  fontSize: 15,
                  color: "#e0e6ed"
                }}>
                  <b>R$ {c.value.toFixed(2)}</b> <span style={{ color: "#80d4ff" }}>•</span> {c.status} <span style={{ color: "#80d4ff" }}>•</span> <b>{c.dueDate}</b>
                </li>
              ))}
            </ul>
          </section>
<br></br>
          <section style={{
            background: "#212135",
            borderRadius: 16,
            padding: "20px 16px 13px 16px",
            color: "#f9fafb",
            boxShadow: "0 2px 10px 0 rgba(80,80,110,0.13)",
            border: "1px solid #283154"
          }}>
            <h3 style={{
              color: "#fff",
              margin: "0 0 12px 0",
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: 1
            }}>Minha Agenda - Top 10</h3>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {eventos.length === 0 ? (
              <li style={{ color: "#ccc" }}>Nenhum evento encontrado.</li>
            ) : (
              eventos.map((ev, idx) => (
                <li key={idx} style={{ marginBottom: 7, color: "#e0e6ed", fontSize: 15 }}>
                  <b>{ev.summary || "(Sem título)"}</b>{" "}
                  <span style={{ color: "#80d4ff" }}>•</span>{" "}
                  {ev.start?.dateTime
                    ? new Date(ev.start.dateTime).toLocaleString("pt-BR", {
                        timeZone: "America/Sao_Paulo",
                        hour: "2-digit",
                        minute: "2-digit",
                        day: "2-digit",
                        month: "2-digit"
                      })
                    : ev.start?.date || ""}
                </li>
              ))
            )}
          </ul>
          </section>
        </aside>
      </main>

      <footer style={{
        marginTop: 25,
        color: "#bbb",
        fontSize: 14,
        letterSpacing: 0.5,
        textAlign: "center"
      }}>
        &copy; {new Date().getFullYear()} Psicologia Supernova | Eva.IA
      </footer>
    </div>

    )
}

export default Painel;
