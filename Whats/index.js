/**
 * index.js
 *
 * Bot de WhatsApp usando whatsapp-web.js e FastAPI (backend Python).
 * Suporta múltiplos logins simultâneos: cada usuário (“numeroPainel”) recebe
 * sua própria instância de Client, com sessão isolada em sessions/<numero>.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

// ─────────────────────────────────────────────────────────────────────────────
// Para cada “numeroPainel” (string sem “@c.us”), vamos manter um objeto com:
// {
//   client: <instância do WhatsApp Client>,
//   botOnline: <boolean>,
//   ultimoQrCode: <string base64 do último QR>,
//   jwt: <string do JWT que autoriza esse cliente>
// }
// ─────────────────────────────────────────────────────────────────────────────
const sessions = {};

/**
 * Cria (ou retorna, se já existir) uma instância de WhatsApp Client para um dado numeroPainel.
 */
function ensureClientForNumero(numeroPainel) {
  if (sessions[numeroPainel]?.client) {
    return sessions[numeroPainel].client;
  }

  // diretório de sessão específico para este número
  const pastaSessao = path.join(__dirname, 'sessions', numeroPainel);
  if (!fs.existsSync(pastaSessao)) {
    fs.mkdirSync(pastaSessao, { recursive: true });
  }

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: pastaSessao }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--enable-experimental-web-platform-features',
        '--enable-features=BackgroundSync',
        '--enable-features=ServiceWorker'
      ]
    }
  });

  // Inicializa o estado
  sessions[numeroPainel] = {
    client,
    botOnline: false,
    ultimoQrCode: null,
    jwt: null
  };

  // Quando o QR code for gerado (primeira vez ou quando expira), salvamos em sessions[numeroPainel].ultimoQrCode
  client.on('qr', async qr => {
    try {
      const base64 = await QRCode.toDataURL(qr);
      sessions[numeroPainel].ultimoQrCode = base64;
      sessions[numeroPainel].botOnline = false;
      console.log(`[${numeroPainel}] QR gerado. Aguardando escanear.`);
    } catch (e) {
      console.error(`[${numeroPainel}] Erro ao gerar QR:`, e);
    }
  });

  let numeroConectado = null
  // Quando estiver “ready”, ou seja, logado, marcamos botOnline = true
  client.on('ready', () => {
    sessions[numeroPainel].botOnline = true;
    sessions[numeroPainel].ultimoQrCode = null; // podemos limpar QR agora
    const numeroConectado = client.info.wid._serialized.split('@')[0];
    console.log(`[${numeroPainel}] WhatsApp pronto! Número conectado: ${numeroConectado}`);
  });

  // Se perder conexão, voltamos a false e forçamos nova geração de QR
  client.on('disconnected', reason => {
    sessions[numeroPainel].botOnline = false;
    sessions[numeroPainel].ultimoQrCode = null;
    console.log(`[${numeroPainel}] Desconectado (${reason}). Aguardando QR novamente.`);
    // O próprio whatsapp-web.js vai reagir disparando 'qr' novamente
  });

  // ─── Quando receber uma mensagem → tratar texto/media com a FastAPI ─────────
  client.on('message', async message => {
    const senderFull = message.from; // ex: “5511999999999@c.us”
    if (senderFull === 'status@broadcast') return;
    const sender = senderFull.split('@')[0]; // ex: “5511999999999”
    if (sender ==='556599994101' ||  sender === '556592382772'  || sender === '559984066965' || sender === '553184500320' || sender === '556584521369' || sender === '5511968797843'){
      console.log("Ignorando...")
      return;
    }
    const body = (message.body||'').trim();

    // Antes de prosseguir, verificamos se ainda temos JWT válido para esse numeroPainel
    const sessionInfo = sessions[numeroPainel];
    if (!sessionInfo || !sessionInfo.jwt) {
      console.log(`[${numeroPainel}] Mensagem recebida de ${sender}, mas sem JWT associado. Ignorando.`);
      return;
    }
    const jwt = sessionInfo.jwt;

    // ─── 1) Texto simples ─────────────────────────────────────────────────────
    if (body) {
      await tratarTextoComIA(body, sender, numeroPainel);
      return;
    }

    // ─── 2) Mídia (áudio, vídeo, imagem) ───────────────────────────────────────
    if (message.hasMedia) {
      try {
        const media = await message.downloadMedia();
        if (!media) {
          console.log(`[${numeroPainel}][${sender}] Falha ao baixar mídia.`);
          return;
        }

        // Se for áudio, transcreve e manda para IA
        if (media.mimetype.startsWith('audio/')) {
          const buffer = Buffer.from(media.data, 'base64');
          const pastaDownloads = path.join(__dirname, 'downloads', numeroPainel);
          if (!fs.existsSync(pastaDownloads)) fs.mkdirSync(pastaDownloads, { recursive: true });

          const ext = mime.extension(media.mimetype) || 'webm';
          const nomeArquivoAudio = `audio_${sender}_${Date.now()}.${ext}`;
          const caminhoAudio = path.join(pastaDownloads, nomeArquivoAudio);
          fs.writeFileSync(caminhoAudio, buffer);
          console.log(`[${numeroPainel}][${sender}] Áudio salvo em ${caminhoAudio}. Transcrevendo…`);

          const textoTranscrito = await transcreverAudio(caminhoAudio);
          if (!textoTranscrito) {
            await client.sendMessage(`${sender}@c.us`, 'Desculpe, não consegui transcrever seu áudio.');
            return;
          }
          console.log(`[${numeroPainel}][${sender}] Transcrição: "${textoTranscrito}"`);
          await tratarTextoComIA(textoTranscrito, sender, numeroPainel);
          return;
        }

        // Se for imagem/video, só salva e confirma
        const extM = mime.extension(media.mimetype) || 'bin';
        const nomeArquivo = `media_${sender}_${Date.now()}.${extM}`;
        const pastaM = path.join(__dirname, 'downloads', numeroPainel);
        if (!fs.existsSync(pastaM)) fs.mkdirSync(pastaM, { recursive: true });
        const caminhoM = path.join(pastaM, nomeArquivo);
        fs.writeFileSync(caminhoM, Buffer.from(media.data, 'base64'));
        console.log(`[${numeroPainel}][${sender}] Mídia salva em ${caminhoM}`);
        await client.sendMessage(`${sender}@c.us`, '✅ Recebi seu arquivo! Obrigado.');
      } catch (err) {
        console.error(`[${numeroPainel}][${sender}] Erro ao processar mídia:`, err);
      }
      return;
    }
  });

  // Inicializa esse client
  client.initialize();
  return client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transcrição de áudio → texto usando Whisper (OpenAI)
// ─────────────────────────────────────────────────────────────────────────────
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function transcreverAudio(caminhoArquivo) {
  try {
    const fileStream = fs.createReadStream(caminhoArquivo);
    const resp = await openai.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1'
    });
    return resp.text;
  } catch (e) {
    console.error('Erro ao transcrever áudio:', e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Envia textoRecebido para a FastAPI (/generate) e devolve respostaIA ao cliente
// ─────────────────────────────────────────────────────────────────────────────
async function tratarTextoComIA(texto, sender, numeroPainel) {
  const sess = sessions[numeroPainel];
  if (!sess || !sess.jwt) {
    console.log(`[${numeroPainel}][${sender}] Sem JWT ao tentar chamar IA.`);
    return;
  }
  const jwt = sess.jwt;

  // 1) Buscar config personalizada para este usuário:
  let config = {};
  try {
    const respConfig = await axios.get('http://localhost:3001/api/get-config', {
      headers: { Authorization: `Bearer ${jwt}` }
    });
    config = respConfig.data || {};
  } catch (e) {
    console.error(`[${numeroPainel}] Erro ao buscar config:`, e.message);
  }

  const numeroConectado = sess.numeroConectado || ''; // ← AQUI está o valor correto

  
  // 2) Montar payload /generate
  const payload = {
    sender, // quem mandou a mensagem (ex: “5511999999999”)
    numeroConectado,
    message: texto,
    customInstructions: config.customInstructions || 'Você é um atendente virtual amigável e eficiente.',
    openaiKey: config.openaiKey || process.env.OPENAI_API_KEY,
    asaasKey: config.asaasKey || '',
    googleClientId: config.googleClientId || '',
    googleClientSecret: config.googleClientSecret || ''
  };

  // 3) Chamar FastAPI
  let respostaIA = { response: 'Desculpe, tivemos um problema interno.', audio_path: null };
  try {
    const resp = await axios.post(
      `${process.env.URL_FASTAPI || 'http://127.0.0.1:8000'}/generate`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`
        },
        timeout: 40000
      }
    );
    respostaIA = resp.data;
  } catch (err) {
    console.error(`[${numeroPainel}][${sender}] Erro ao chamar FastAPI:`, err.message);
  }

  
  // 4) Enviar resposta de volta via WhatsApp
  const client = sess.client;
  // (a) se interactive buttons
  if (respostaIA.interactive && respostaIA.interactive.type === 'buttons') {
    try {
      const dados = respostaIA.interactive;
      const options = (dados.action.buttons || []).map(b => b.reply);
      let txt = 'Opções:\n\n';
      options.forEach((opt, i) => {
        txt += `${i+1}) ${opt.title}\n`;
      });
      txt += '\nPor favor, responda com o número correspondente (ex: 1).';
      await client.sendMessage(`${sender}@c.us`, txt);
      return;
    } catch (e) {
      console.error(`[${numeroPainel}][${sender}] Erro ao enviar buttons:`, e);
    }
  }
  

  // (b) se vier audio_path e 50% sorte
  const rand = Math.random();
  if (respostaIA.audio_path && rand >= 0.6) {
    try {
      const caminhoAudio = path.resolve(__dirname, respostaIA.audio_path);
      const media = MessageMedia.fromFilePath(caminhoAudio);
      await client.sendMessage(`${sender}@c.us`, media, {
        sendAudioAsVoice: true,
        mimetype: mime.lookup(caminhoAudio) || 'audio/mpeg'
      });
      return;
    } catch (e) {
      console.error(`[${numeroPainel}][${sender}] Erro ao enviar áudio IA:`, e);
    }
  }

  // (c) fallback texto simples
  if (respostaIA.response) {
    try {
      await client.sendMessage(`${sender}@c.us`, respostaIA.response);
    } catch (e) {
      console.error(`[${numeroPainel}][${sender}] Erro ao enviar texto IA:`, e);
    }
  } 
} 

// ─────────────────────────────────────────────────────────────────────────────
// ─── CONFIGURAÇÃO DO EXPRESS / API REST PARA O PAINEL ────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allowed = ['http://localhost:3000', 'http://127.0.0.1:3000'];
      if (allowed.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS bloqueou: ${origin}`), false);
    },
    methods: ['GET','POST'],
    allowedHeaders: ['Content-Type','Authorization']
  })
);

/**
 * POST /api/receive-token
 * Quando o Painel React faz login, envia:
 *   { numero: "<5511999999999>", token: "<JWT do painel>" }
 * 
 * Aqui:
 * - guardamos jwtPorNumero[numero] = token
 * - garantimos que exista um Client para esse “numero” (ou criamos um novo)
 */
app.post('/api/receive-token', (req, res) => {
  const { numero, token } = req.body;
  if (!numero || !token) {
    return res.status(400).json({ error: 'Envie { numero, token }.' });
  }
  // Armazena ou atualiza o JWT para esse numero
  if (!sessions[numero]) {
    // cria o client pela primeira vez
    console.log(`[API] Criando nova sessão para numeroPainel=${numero}`);
    const client = ensureClientForNumero(numero);
    sessions[numero].jwt = token;
  } else {
    // já existia uma instância: apenas atualiza o JWT
    sessions[numero].jwt = token;
  }
  console.log(token)
  return res.json({ success: true });
});

/**
 * GET /api/whatsapp-qr?numero=<numeroPainel>
 * Retorna { qr: <stringBase64> } para aquele usuário específico, ou null se não houver.
 */
app.get('/api/whatsapp-qr', (req, res) => {
  const numero = req.query.numero;
  if (!numero) {
    return res.status(400).json({ error: 'Faltou ?numero=...' });
  }
  const sess = sessions[numero];
  const qr = sess?.ultimoQrCode || null;
  return res.json({ qr });
});

/**
 * GET /api/whatsapp-status?numero=<numeroPainel>
 * Retorna { online: true/false } indicando se a instância daquele usuário está pronta.
 */
app.get('/api/whatsapp-status', (req, res) => {
  const numero = req.query.numero;
  if (!numero) {
    return res.status(400).json({ error: 'Faltou ?numero=...' });
  }
  const sess = sessions[numero];
  const online = !!(sess && sess.botOnline);
  return res.json({ online });
});

/**
 * GET /api/me?numero=<numeroPainel>
 * Retorna { numero: "<numero do WhatsApp conectado>" } quando estiver online,
 * ou 404 se ainda não estiver conectado / sem session.
 */
app.get('/api/me', (req, res) => {
  const numero = req.query.numero;
  if (!numero) {
    return res.status(400).json({ error: 'Faltou ?numero=...' });
  }
  const sess = sessions[numero];
  if (!sess || !sess.botOnline) {
    return res.status(404).json({ error: 'Ainda não logado ou QR não escaneado.' });
  }
  const botNum = sess.client.info.wid._serialized.split('@')[0];
  return res.json({ numero: botNum });
});







// Inicializa o Express na porta 3335 (ou PORT_BOT)
const PORT_BOT = process.env.PORT_BOT || 3335;
app.listen(PORT_BOT, () => {
  console.log(`[API] WhatsApp multi-sessão rodando na porta ${PORT_BOT}`);
});
