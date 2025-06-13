/**
 * server.js
 */

require('dotenv').config();

const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const mongoSanitize = require('express-mongo-sanitize');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const xss = require('xss');
const { google } = require('googleapis'); // <-- Import do OAuth2
const app = express();

// ===== CONFIGURAÇÕES GLOBAIS =====

// Helmet adiciona headers de segurança
app.use(helmet());

// Body parser JSON
app.use(express.json());

// Sanitiza parâmetros que chegarem em JSON (protege contra NoSQL injection)
app.use(mongoSanitize());

// CORS: permita somente origens confiáveis (ajuste conforme seu domínio / localhost)
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  // Adicione aqui a URL de produção, se tiver (ex: 'https://meusite.com').
];
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1) {
        return callback(
          new Error(`CORS: Origem ${origin} não autorizada.`),
          false
        );
      }
      return callback(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Conexão com MongoDB (removidas opções deprecadas)
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB Atlas conectado!'))
  .catch((err) =>
    console.error('Erro ao conectar no Atlas – verifique MONGO_URI:', err)
  );

// Definição de esquema do usuário
const UsuarioSchema = new mongoose.Schema(
  {
    nome: { type: String, required: true, trim: true, minlength: 2 },
    numero: { type: String, required: true, unique: true, trim: true, minlength: 8 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    senha: { type: String, required: true },
  },
  { timestamps: true }
);
const Usuario = mongoose.model('Usuario', UsuarioSchema);

// Definição de esquema de Configurações do Usuário
const ConfigSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Types.ObjectId, ref: 'Usuario', required: true, unique: true },
    customInstructions: { type: String, default: '' },
    openaiKey: { type: String, default: '' },
    asaasKey: { type: String, default: '' },
    googleClientId: { type: String, default: '' },
    googleClientSecret: { type: String, default: '' },
    // Campos para armazenar tokens OAuth2
    googleAccessToken: { type: String },
    googleRefreshToken: { type: String },
    googleTokenExpiryDate: { type: Number },
  },
  { timestamps: true }
);
const Config = mongoose.model('Config', ConfigSchema);

const MemoriaSchema = new mongoose.Schema(
  {
    numero:   { type: String, required: true, unique: true },
    userId:   { type: mongoose.Types.ObjectId, ref: "Usuario", required: true },
    history: [
      {
        from:      { type: String, enum: ["user", "bot"], required: true },
        text:      { type: String, required: true },
        timestamp: { type: Date, default: () => new Date() },
      }
    ],
    profile: {
      name: { type: String, default: null },
      phone: { type: String, default: null },
      idade: { type: String, default: null },
      resumoDasInteracoes: { type: String, default: null },
      ultimoagendamento: { type: String, default: null } //
    }    
  },
  { timestamps: true }
);

const Memoria = mongoose.model("Memoria", MemoriaSchema);

// ===== RATE LIMIT (para reduzir brute force) =====
const loginLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 8,                  // até 8 tentativas dentro deste minuto
  message: {
    ok: false,
    msg: 'Muitas tentativas de login. Por favor, aguarde 1 minuto e tente novamente.',
  },
});

// ===== MIDDLEWARE DE AUTENTICAÇÃO (JWT) =====
function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ ok: false, msg: 'Token não fornecido.' });

  // Esperamos o formato "Bearer <token>"
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer')
    return res.status(401).json({ ok: false, msg: 'Header Authorization inválido.' });

  const token = parts[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, nome, numero, email, iat, exp }
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, msg: 'Token inválido ou expirado.' });
  }
}

// ===== UTILITÁRIOS PARA GOOGLE OAUTH2 =====

// Cria um cliente OAuth2 para o usuário, baseado em credenciais salvas no Config do Mongo
async function criarOAuth2Client(userId) {
  const config = await Config.findOne({ userId }).lean();
  if (!config?.googleClientId || !config?.googleClientSecret) {
    throw new Error('Google Credentials não configuradas para este usuário.');
  }

  // 'google.auth.OAuth2' já foi importado no topo
  const oauth2Client = new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    'http://localhost:3001/api/google/oauth2callback' // http://localhost:3001/api/google/oauth2callback, - precisa ser idêntica à “Authorized redirect URI” no Console do Google
  );

  return oauth2Client;
}

// Recupera um cliente OAuth2 já autenticado (com tokens no banco)
// e configura listeners para atualizar refresh_token / access_token automaticamente
async function getOAuthClientComToken(userId) {
  const cfg = await Config.findOne({ userId }).lean();
  if (!cfg?.googleClientId || !cfg?.googleClientSecret || !cfg?.googleAccessToken) {
    throw new Error('Usuário não autorizado no Google Calendar.');
  }

  const oauth2Client = new google.auth.OAuth2(
    cfg.googleClientId,
    cfg.googleClientSecret,
    'http://localhost:3001/api/google/oauth2callback'
  );
  oauth2Client.setCredentials({
    access_token: cfg.googleAccessToken,
    refresh_token: cfg.googleRefreshToken,
    expiry_date: cfg.googleTokenExpiryDate,
  });

  // Quando o OAuth2Client obtiver novos tokens (por refresh automático), atualize o banco
  oauth2Client.on('tokens', async (tokens) => {
    if (tokens.refresh_token) {
      await Config.findOneAndUpdate(
        { userId },
        { $set: { googleRefreshToken: tokens.refresh_token } }
      );
    }
    if (tokens.access_token) {
      await Config.findOneAndUpdate(
        { userId },
        {
          $set: {
            googleAccessToken: tokens.access_token,
            googleTokenExpiryDate: tokens.expiry_date,
          },
        }
      );
    }
  });

  return oauth2Client;
}

// ===== ROTAS GOOGLE CALENDAR =====

// Callback OAuth2: troca o "code" por access_token e refresh_token, salva no banco e redireciona
app.get('/api/google/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Código de autorização ausente.');

  try {
    // Supondo que você passe o JWT do painel como state: ?code=...&state=<jwt>
    const tokenJwt = req.query.state;
    const payload = jwt.verify(tokenJwt, process.env.JWT_SECRET);
    const userId = payload.id;

    const oauth2Client = await criarOAuth2Client(userId);
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Salva tokens na coleção Config
    await Config.findOneAndUpdate(
      { userId },
      {
        $set: {
          googleAccessToken: tokens.access_token,
          googleRefreshToken: tokens.refresh_token,
          googleTokenExpiryDate: tokens.expiry_date,
        },
      },
      { upsert: true }
    );

    // Redireciona de volta ao frontend (por exemplo, a página inicial do painel)
    return res.redirect('http://localhost:3000');
  } catch (err) {
    console.error('[Google OAuth2 Callback]', err);
    return res.status(500).send('Falha ao trocar código por tokens.');
  }
});

// Retorna a URL de consentimento Google para abrir no frontend
app.get('/api/google/get-auth-url', auth, async (req, res) => {
  try {
    const oauth2Client = await criarOAuth2Client(req.user.id);

    // Scopes mínimos para ler/criar eventos no Calendar:
    const scopes = [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
    ];

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent', // força refresh_token na primeira autorização
      state: req.headers.authorization.split(' ')[1], // envia JWT como state para o callback
    });

    return res.json({ url: authUrl });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, msg: 'Não foi possível gerar Auth URL.' });
  }
});

const nodemailer = require('nodemailer');

app.post('/api/esqueci-senha', async (req, res) => {
  const { email } = req.body;
  console.log('🔥 Rota /api/esqueci-senha acessada com:', req.body);

  try {
    const user = await Usuario.findOne({ email });
    console.log('🔍 Resultado do MongoDB:', user);

    if (!user) {
      console.log('⚠️ Usuário não encontrado.');
      return res.json({ msg: 'Se este e-mail existir, você receberá as instruções em instantes.' });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30m' });
    console.log('🔐 Token JWT gerado:', token);

    const link = `${process.env.FRONTEND_URL}/resetar-senha/${token}`;
    console.log('🔗 Link de recuperação:', link);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    console.log('📤 Enviando e-mail...');

    const info = await transporter.sendMail({
      from: `"EVA Supernova" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Recuperação de senha – EVA',
      html: `
        <h2>Olá!</h2>
        <p>Você solicitou a recuperação da sua senha. Clique no botão abaixo para redefinir:</p>
        <a href="${link}" style="padding: 10px 15px; background: #007bff; color: white; text-decoration: none; border-radius: 6px;">Redefinir senha</a>
        <p>Este link expira em 30 minutos.</p>
      `
    });

    console.log('✅ E-mail enviado:', info.messageId);
    res.json({ msg: 'Se este e-mail existir, você receberá as instruções em instantes.' });

  } catch (err) {
    console.error('❌ Erro no processo de recuperação:', err.message || err);
    res.status(500).json({ msg: 'Erro interno ao tentar enviar o e-mail.' });
  }
});

    

app.post('/api/resetar-senha/:token', async (req, res) => {
  const { token } = req.params;
  const { novaSenha } = req.body;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await Usuario.findById(decoded.id);
    if (!user) return res.status(404).json({ msg: 'Usuário não encontrado' });

    const hash = await bcrypt.hash(novaSenha, 12);
    user.senha = hash;
    await user.save();

    return res.json({ ok: true, msg: 'Senha redefinida com sucesso!' });
  } catch (err) {
    return res.status(400).json({ ok: false, msg: 'Token inválido ou expirado' });
  }
});




app.get('/api/horarios-disponiveis', auth, async (req, res) => {
  try {
    // 1) Pega o OAuth2Client autenticado
    const oauth2Client = await getOAuthClientComToken(req.user.id);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    // 2) Define intervalo de busca (de agora até +7 dias)
    const now = new Date();
    const timeMin = now.toISOString();
    const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const timeMax = sevenDaysLater.toISOString();

    // 3) Busca todos os eventos nos próximos 7 dias
    const eventsResponse = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });
    const events = eventsResponse.data.items || [];

    // 4) Lê o parâmetro `?date=YYYY-MM-DD` (se existir)
    const requestedDate = req.query.date; // ex: "2025-06-06"

    // 5) Filtra somente eventos que:
    //    a) Têm title “Disponível” (ou “disponivel”) OU
    //    b) Não têm summary e caem entre 09:00 e 18:59 (hora >= 9 e < 19)
    //    c) Se veio `date`, também exige que o início comece com “YYYY-MM-DDT…”
    const disponiveis = events.filter(event => {
      // --- 5.c) Filtra pela data exata se o cliente passou ?date=YYYY-MM-DD ---
      const inicioISO = event.start.dateTime || event.start.date || '';
      if (requestedDate && !inicioISO.startsWith(requestedDate + 'T')) {
        return false;
      }
      
      // --- 5.a) Se o summary contém “disponível” (com ou sem acento) ---
      if (event.summary) {
        const textoLower = event.summary.toLowerCase();
        if (textoLower.includes('disponível') || textoLower.includes('disponivel')) {
          return true;
        }
        // Se tiver summary mas não for “disponível”, já exclui
        return false;
      }

      // --- 5.b) Se não existe summary (ou é vazio), considera “sem evento marcado” ---
      //       e devolve true apenas se a hora estiver entre 09 e 18 (i.e. < 19)
      // Extrai hora (0–23) do ISO string (ex.: "2025-06-10T14:00:00-03:00")
      const hora = new Date(inicioISO).getHours();
      return hora >= 9 && hora < 19;
    });

    // 6) Monta o payload final incluindo `id`, `titulo`, `inicio` e `fim`
    const horariosDisponiveis = disponiveis.map(event => ({
      id:     event.id,                         // precisamos do id para editar depois
      titulo: event.summary || '---',           // se não tiver summary, pode deixar string vazia ou ‘---’
      inicio: event.start.dateTime || event.start.date,
      fim:    event.end.dateTime   || event.end.date,
    }));

    return res.json({ horarios: horariosDisponiveis });
  } catch (err) {
    console.error('[horarios-disponiveis]', err);
    return res
      .status(500)
      .json({ ok: false, msg: 'Falha ao buscar horários disponíveis.' });
  }
});


const freeSlotsPorUsuario = {};

app.get('/api/horarios-disponiveis2', auth, async (req, res) => {
  try {
    // 1) Configurações iniciais
    const oauth2Client = await getOAuthClientComToken(req.user.id);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const now = new Date();
    const timeMin = now.toISOString();
    const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const timeMax = sevenDaysLater.toISOString();

    // 2) Chama o FreeBusy para saber todos os períodos ocupados
    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        items: [{ id: 'primary' }],
      }
    });
    const busyPeriods = fb.data.calendars.primary.busy; 
    // busyPeriods é array de { start: "2025-06-08T10:00:00-03:00", end: "2025-06-08T11:00:00-03:00" }

    // 3) Para cada um dos próximos 7 dias, criamos blocos de 1h entre 09:00 e 19:00 e removemos
    //    os intervalos que colidem com busyPeriods. O resultado são horas livres “exatas” de 1 hora.
    const slotsLivres = [];
    const MILLISEGUNDO = 1000;
    const MINUTO = 60 * MILLISEGUNDO;

    for (let diaOffset = 0; diaOffset < 7; diaOffset++) {
      // cria um objeto Date para as 09:00 deste dia
      const dia = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diaOffset, 9, 0, 0);
      for (let horaBase = 9; horaBase < 19; horaBase++) {
        const inicio = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), horaBase, 0, 0);
        const fim = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), horaBase + 1, 0, 0);
        // não consideramos blocos que já passaram
        if (inicio < now) continue;

        // verifica colisão com algum busyPeriod
        const colide = busyPeriods.some(b => {
          const busyStart = new Date(b.start);
          const busyEnd = new Date(b.end);
          // colisão se inicio < busyEnd e fim > busyStart
          return inicio < busyEnd && fim > busyStart;
        });

        if (!colide) {
          // criar um slot livre: o “id” aqui é gerado internamente para identificarmos depois
          slotsLivres.push({
            id: uuidv4(),
            inicio: inicio.toISOString(),
            fim: fim.toISOString(),
          });
        }
      }
    }

    // 4) Armazena em cache para este usuário
    freeSlotsPorUsuario[req.user.id] = slotsLivres;

    // 5) Retorna apenas id + inicio + fim (ou você pode omitir “fim” se usar sempre 1h fixa)
    return res.json({
      horarios: slotsLivres.map(s => ({
        id: s.id,
        inicio: s.inicio,
        fim: s.fim
      }))
    });
  } catch (err) {
    console.error('[horarios-disponiveis]', err);
    return res.status(500).json({ ok: false, msg: 'Falha ao buscar horários disponíveis.' });
  }
});

app.put(
  '/api/google/editar-evento',
  auth,
  [
    body('id').isString().withMessage('id do evento é obrigatório.'),
    body('summary').isString().withMessage('summary é obrigatório.').trim().escape(),
    body('start').isObject().withMessage('start deve ser objeto com dateTime ISO.'),
    body('end').isObject().withMessage('end deve ser objeto com dateTime ISO.'),
    // colorId é opcional, mas se vier, deve ser string
    body('colorId').optional().isString().trim().escape(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ ok: false, erros: errors.array() });
    }

    try {
      // 1) Obter OAuth2Client autenticado
      const oauth2Client = await getOAuthClientComToken(req.user.id);
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      // 2) Construir o objeto de edição
      const eventId = req.body.id;
      const updatedEvent = {
        summary: req.body.summary,
        start:   { dateTime: req.body.start.dateTime },
        end:     { dateTime: req.body.end.dateTime },
        // Se quiser passar colorId, ele precisa estar dentro de "requestBody"
        colorId: req.body.colorId || undefined,
      };

      // 3) Chamar Google Calendar API para atualizar
      const response = await calendar.events.update({
        calendarId: 'primary',
        eventId,
        requestBody: updatedEvent,
      });

      return res.json({ ok: true, evento: response.data });
    } catch (err) {
      console.error('[Google Calendar] editar-evento:', err);
      return res.status(500).json({ ok: false, msg: 'Falha ao editar evento.' });
    }
  }
);


// Listar eventos do calendário do usuário autenticado
app.get('/api/google/listar-eventos2', auth, async (req, res) => {
  try {
    const oauth2Client = await getOAuthClientComToken(req.user.id);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults: 10,
      singleEvents: true,
      orderBy: 'startTime',
    });

    return res.json({ eventos: response.data.items });
  } catch (err) {
    console.error('[Google Calendar] listar-eventos:', err);
    return res.status(500).json({ ok: false, msg: 'Falha ao listar eventos.' });
  }
});


app.get('/api/google/listar-eventos', auth, async (req, res) => {
  try {
    const oauth2Client = await getOAuthClientComToken(req.user.id);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });

    // Filtra só os eventos que tem título exatamente 'Atendimento'
    const eventosAtendimento = response.data.items.filter(evento => evento.summary === 'Atendimento');

    return res.json({ eventos: eventosAtendimento });
  } catch (err) {
    console.error('[Google Calendar] listar-eventos-hoje-atendimento:', err);
    return res.status(500).json({ ok: false, msg: 'Falha ao listar eventos de atendimento de hoje.' });
  }
});

// GET /api/memoria/resumo-por-nome/:nome
app.get("/api/memoria/resumo-por-nome/:nome", auth, async (req, res) => {
  const nome = req.params.nome?.toLowerCase();
  const userId = req.user.id;

  try {
    const doc = await Memoria.findOne({
      userId,
      "profile.name": { $regex: new RegExp(`^${nome}$`, "i") }
    });

    if (!doc) {
      return res.status(404).json({ ok: false, msg: "Cliente não encontrado pelo nome." });
    }

    return res.json({
      ok: true,
      numero: doc.numero,
      nome: doc.profile.name,
      history: doc.history || []
    });
  } catch (err) {
    console.error("[GET /api/memoria/resumo-por-nome/:nome]", err);
    return res.status(500).json({ ok: false, msg: "Erro ao buscar resumo por nome." });
  }
});



app.get("/api/memoria/resumo/:numero", auth, async (req, res) => {
  const numero = req.params.numero;
  const userId = req.user.id;

  try {
    const doc = await Memoria.findOne({ numero, userId });
    if (!doc) {
      return res.status(404).json({ ok: false, msg: "Memória não encontrada." });
    }

    const { history, profile } = doc;

    // Resumo simples baseado em histórico
    const interacoesUser = history.filter(h => h.from === "user").map(h => h.text);
    const interacoesBot = history.filter(h => h.from === "bot").map(h => h.text);

    let resumo = `Cliente ${profile.name || numero}`;
    if (profile.idade) resumo += `, idade ${profile.idade}`;
    resumo += `, teve ${interacoesUser.length} interações.`;

    if (interacoesUser.length > 0) {
      resumo += ` Demonstrou interesse em: ${interacoesUser.slice(-3).join("; ")}.`;
    }

    if (profile.ultimoagendamento) {
      resumo += ` Último agendamento registrado: ${profile.ultimoagendamento}.`;
    }

    // Limita o resumo para não ficar muito extenso
    resumo = resumo.slice(0, 600);

    // Atualiza o campo
    doc.profile.resumoDasInteracoes = resumo;
    await doc.save();

    return res.json({ ok: true, resumo });
  } catch (err) {
    console.error("[GET /api/memoria/resumo/:numero]", err);
    return res.status(500).json({ ok: false, msg: "Erro ao gerar resumo." });
  }
});

// Rota para listar todos os eventos de HOJE (independente do título)
app.get('/api/google/eventos-hoje', auth, async (req, res) => {
  try {
    const oauth2Client = await getOAuthClientComToken(req.user.id);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    return res.json({ eventos: response.data.items || [] });
  } catch (err) {
    console.error('[Google Calendar] eventos-hoje:', err);
    return res.status(500).json({ ok: false, msg: 'Erro ao listar eventos de hoje.' });
  }
});



/**
 * GET /api/horarios-disponiveis-por-dia?date=YYYY-MM-DD
 *
 * Retorna todos os horários de 1h (“slots”) entre 09:00 e 19:00
 * que não estejam ocupados por nenhum evento cujo summary contenha “Atendimento”.
 *
 * Requisitos:
 *   • Usuário autenticado (middleware `auth`).
 *   • `date` na query string no formato `YYYY-MM-DD`.
 *   • Verifica todos os eventos desse dia no Google Calendar.
 *   • Se NÃO houver evento “Atendimento” sobrepondo o slot, inclui-o nos disponíveis.
 */
app.get('/api/horarios-disponiveis-por-dia', auth, async (req, res) => {
  try {
    const { date } = req.query; // ex: "2025-06-10"
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res
        .status(400)
        .json({ ok: false, msg: 'Parâmetro “date” ausente ou inválido. Use YYYY-MM-DD.' });
    }

    // 1) Cria o OAuth2Client já autenticado para este usuário
    const oauth2Client = await getOAuthClientComToken(req.user.id);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    // 2) Monta os limites de busca: 09:00 e 19:00 no fuso -03:00 daquele dia
    //    (ajuste o fuso caso seu calendário use outro offset)
    const timeMin = new Date(`${date}T09:00:00-03:00`).toISOString();
    const timeMax = new Date(`${date}T19:00:00-03:00`).toISOString();

    // 3) Busca todos os eventos ENTRE 09:00 e 19:00
    const eventsResponse = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });
    const eventos = eventsResponse.data.items || [];

    // 4) Filtra apenas eventos cujo summary contenha “Atendimento”
    //    (se seu padrão for outro, ajuste aqui)
    const atendimentoEvents = eventos.filter((ev) => {
      const summary = (ev.summary || '').toLowerCase();
      return summary.includes('atendimento');
    });

    // 5) Gera TODOS os possíveis slots de 1h de duração entre 09:00 e 19:00
    //    Ex.: 09:00–10:00, 10:00–11:00, …, 18:00–19:00
    const slots = [];
    for (let hora = 9; hora < 19; hora++) {
      // Exemplo: para hora=9 => inicia em "YYYY-MM-DDT09:00:00-03:00", termina em "YYYY-MM-DDT10:00:00-03:00"
      const inicioSlot = new Date(`${date}T${String(hora).padStart(2, '0')}:00:00-03:00`);
      const fimSlot = new Date(`${date}T${String(hora + 1).padStart(2, '0')}:00:00-03:00`);
      slots.push({ inicio: inicioSlot, fim: fimSlot });
    }

    // 6) Para cada slot, verifica se há overlap com algum atendimento existente
    //    Overlap ocorre quando (slot.inicio < evFim) E (slot.fim > evInicio)
    const disponiveis = slots.filter(({ inicio, fim }) => {
      for (const ev of atendimentoEvents) {
        const evInicio = new Date(ev.start.dateTime || ev.start.date);
        const evFim = new Date(ev.end.dateTime || ev.end.date);
        if (inicio < evFim && fim > evInicio) {
          // conflito detectado → bloqueia este slot
          return false;
        }
        console.log("disponiveis:" , disponiveis)
      }
      return true; // sem conflito → slot livre
    });

    // 7) Formata o JSON de resposta — pode incluir horário em ISO ou só hora/minuto
    //    Aqui vamos retornar {hora: "09:00", inicio: "...ISO...", fim: "...ISO..."}, por exemplo.
    const resultado = disponiveis.map(({ inicio, fim }) => {
      // extrair só HH:MM para facilitar
      const horaStr = inicio.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'America/Sao_Paulo', // ou ajuste para seu fuso
      });
      return {
        hora: horaStr,           // ex: "09:00"
        inicio: inicio.toISOString(),
        fim: fim.toISOString(),
      };
    });

    return res.json({ ok: true, date, disponiveis: resultado });
  } catch (err) {
    console.error('[API Horários Disponíveis]', err);
    return res.status(500).json({
      ok: false,
      msg: 'Erro ao buscar horários disponíveis.',
      detalhes: err.message || err,
    });
  }
});


const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });

app.post("/api/formatarconh", upload.single("arquivo"), async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  console.log(token)
  if (!token) return res.status(401).json({ msg: "Token ausente" });

  let nomeUsuario;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    nomeUsuario = payload.nome || "desconhecido";
    console.log(nomeUsuario)
  } catch {
    return res.status(401).json({ msg: "Token inválido" });
  }

  if (!req.file) return res.status(400).json({ msg: "Arquivo ausente" });

  const caminhoTemporario = req.file.path;
  const textoOriginal = fs.readFileSync(caminhoTemporario, "utf8");

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: [
        {
          role: "system",
          content: `Você é um assistente especializado em construir bases de conhecimento para sistemas RAG (Retrieval-Augmented Generation). Sua tarefa é transformar um texto fornecido em formato CSV, no seguinte padrão:

          pergunta,resposta  
          Oi,"Olá, como posso ajudar?"  
          Qual o valor da sessão?,"O valor da sessão individual on-line é de R$300,00."  
          ...
          
          ⚠️ Regras obrigatórias:
          
          1. Cada linha deve conter **exatamente uma pergunta e uma resposta**.  
          2. A **pergunta** nunca deve estar entre aspas.  
          3. A **resposta** deve estar sempre entre **aspas duplas**.  
          4. Remova quebras de linha internas e pontuações desnecessárias nas respostas.  
          5. A primeira linha do CSV deve ser: **pergunta,resposta** (exatamente assim, tudo em minúsculo).
          
          📌 Se o conteúdo enviado **não estiver no formato de perguntas e respostas**, analise o contexto e:
          
          - Converta explicações em perguntas e respostas coerentes.
          - Reescreva como se fosse um diálogo natural entre cliente e atendente.
          
          📌 NÃO retorne comentários, explicações ou qualquer outro texto além do CSV.
          
          Retorne SOMENTE o conteúdo CSV, corretamente formatado.
          `          
        },
        
        {
          role: "user",
          content: textoOriginal
        }
      ],
      temperature: 0.3
    });

    const csvFormatado = completion.choices[0].message.content;

    const nomeArquivo = `base_form_${nomeUsuario}.csv`;
    const caminhoFinal = path.join(__dirname, "../../AgenteLLM", nomeArquivo);

    fs.writeFileSync(caminhoFinal, csvFormatado);
    fs.unlinkSync(caminhoTemporario); // limpa o arquivo .txt enviado

    res.json({ ok: true, msg: "Base salva com sucesso", nomeArquivo });
  } catch (err) {
    console.error("[/api/formatarconh]", err);
    res.status(500).json({ ok: false, msg: "Erro ao formatar base" });
  }
});


// Criar um novo evento no calendário do usuário autenticado
/*
app.post(
  '/api/google/criar-evento',
  auth,
  [
    body('summary').isString().withMessage('summary é obrigatório.').trim().escape(),
    body('start').isISO8601().withMessage('start deve ser data ISO.'),
    body('end').isISO8601().withMessage('end deve ser data ISO.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ ok: false, erros: errors.array() });
    }

    try {
      const oauth2Client = await getOAuthClientComToken(req.user.id);
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      const evento = {
        summary: req.body.summary,
        start: { dateTime: req.body.start },
        end: { dateTime: req.body.end },
      };

      const response = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: evento,
      });

      return res.json({ ok: true, evento: response.data });
    } catch (err) {
      console.error('[Google Calendar] criar-evento:', err);
      return res.status(500).json({ ok: false, msg: 'Falha ao criar evento.' });
    }
  }
);

*/
// ===== ROTAS AUTENTICAÇÃO USUÁRIO =====

// 2.5) Endpoint para “quem sou eu” (dados vindos do próprio JWT)
app.get('/api/me', auth, (req, res) => {
  const { id, nome, numero, email } = req.user;
  return res.json({ ok: true, id, nome, numero, email });
});

// 1) Cadastro de usuário
app.post(
  '/api/cadastro',
  [
    body('nome').trim().isLength({ min: 2 }).withMessage('Nome deve ter pelo menos 2 caracteres.'),
    body('numero')
      .trim()
      .isLength({ min: 8 })
      .withMessage('Número de WhatsApp inválido.')
      .matches(/^\d+$/)
      .withMessage('Número deve conter apenas dígitos.'),
    body('email').isEmail().withMessage('E-mail inválido.').normalizeEmail(),
    body('senha').isLength({ min: 8 }).withMessage('Senha deve ter pelo menos 8 caracteres.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ ok: false, erros: errors.array() });

    const { nome, numero, email, senha } = req.body;
    try {
      const salt = await bcrypt.genSalt(12);
      const hash = await bcrypt.hash(senha, salt);

      const usuario = new Usuario({ nome, numero, email, senha: hash });
      await usuario.save();

      return res.json({ ok: true, msg: 'Cadastro realizado com sucesso!' });
    } catch (err) {
      if (err.code === 11000) {
        if (err.keyPattern?.numero) return res.status(400).json({ ok: false, msg: 'Este número já está cadastrado.' });
        if (err.keyPattern?.email) return res.status(400).json({ ok: false, msg: 'Este e-mail já está cadastrado.' });
      }
      return res.status(500).json({ ok: false, msg: 'Erro interno. Tente novamente.' });
    }
  }
);

// 2) Login de usuário
app.post(
  '/api/login',
  loginLimiter,
  [
    body('email').isEmail().withMessage('E-mail inválido.').normalizeEmail(),
    body('senha').isString().withMessage('Senha obrigatória.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ ok: false, erros: errors.array() });

    const { email, senha } = req.body;
    try {
      const usuario = await Usuario.findOne({ email });
      if (!usuario) return res.status(401).json({ ok: false, msg: 'Credenciais incorretas.' });

      const senhaOk = await bcrypt.compare(senha, usuario.senha);
      if (!senhaOk) return res.status(401).json({ ok: false, msg: 'Credenciais incorretas.' });

      const payload = { id: usuario._id.toString(), nome: usuario.nome, numero: usuario.numero, email: usuario.email };
      const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '24h' });

      return res.json({ ok: true, token, nome: usuario.nome, numero: usuario.numero });
    } catch (err) {
      return res.status(500).json({ ok: false, msg: 'Erro interno. Tente novamente.' });
    }
  }
);

// ===== ROTAS DE CONFIGURAÇÕES =====

// 3) Salvar / Atualizar configurações do usuário
app.post(
  '/api/save-config',
  auth,
  [
    body('customInstructions').optional().isString().trim().escape(),
    body('openaiKey').optional().isString().trim(),
    body('asaasKey').optional().isString().trim(),
    body('googleClientId').optional().isString().trim(),
    body('googleClientSecret').optional().isString().trim(),
  ],
  async (req, res) => {
    const userId = req.user.id;
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ ok: false, erros: errors.array() });

    const customInstructions = xss(req.body.customInstructions || '');
    const openaiKey = xss(req.body.openaiKey || '');
    const asaasKey = xss(req.body.asaasKey || '');
    const googleClientId = xss(req.body.googleClientId || '');
    const googleClientSecret = xss(req.body.googleClientSecret || '');

    try {
      let config = await Config.findOne({ userId });
      if (!config) config = new Config({ userId });

      config.customInstructions = customInstructions;
      config.openaiKey = openaiKey;
      config.asaasKey = asaasKey;
      config.googleClientId = googleClientId;
      config.googleClientSecret = googleClientSecret;
      await config.save();

      return res.json({ ok: true, msg: 'Configurações salvas!' });
    } catch (err) {
      return res.status(500).json({ ok: false, msg: 'Erro ao salvar configurações.' });
    }
  }
);

// 4) Buscar configurações do usuário
app.get('/api/get-config', auth, async (req, res) => {
  const userId = req.user.id;
  try {
    const config = await Config.findOne({ userId }).lean();
    if (!config) return res.json({});
    return res.json({
      customInstructions: config.customInstructions,
      openaiKey: config.openaiKey,
      asaasKey: config.asaasKey,
      googleClientId: config.googleClientId,
      googleClientSecret: config.googleClientSecret,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, msg: 'Erro ao buscar configurações.' });
  }
});

// ===== ROTA PARA O PAINEL ASOAS =====

// Busca token Asaas salvo para o userId
async function getAsaasTokenByUserId(userId) {
  const config = await Config.findOne({ userId }).lean();
  return config?.asaasKey || null;
}

// Função auxiliar para chamar endpoints Asaas
async function fetchAsaas(userId, endpoint, params = {}) {
  const asaasToken = await getAsaasTokenByUserId(userId);
  if (!asaasToken) throw new Error('Token Asaas não configurado para o usuário.');
  const url = `https://www.asaas.com/api/v3/${endpoint}`;
  const { data } = await axios.get(url, {
    params,
    headers: { access_token: asaasToken },
  });
  return data;
}

// 5) Rota para obter dados do painel Asaas
app.get('/api/painel', auth, async (req, res) => {
  const userId = req.user.id;
  try {
    const [customers, payments, paymentsReceived, paymentsPending, paymentsOverdue] =
      await Promise.all([
        fetchAsaas(userId, 'customers'),
        fetchAsaas(userId, 'payments'),
        fetchAsaas(userId, 'payments', { status: 'RECEIVED' }),
        fetchAsaas(userId, 'payments', { status: 'PENDING' }),
        fetchAsaas(userId, 'payments', { status: 'OVERDUE' }),
      ]);

    const totalRecebido = (paymentsReceived.data || []).reduce((sum, item) => sum + (item.value || 0), 0);
    const totalPending = (paymentsPending.data || []).reduce((sum, item) => sum + (item.value || 0), 0);
    const totalOverdue = (paymentsOverdue.data || []).reduce((sum, item) => sum + (item.value || 0), 0);

    return res.json({
      totalClientes: customers.totalCount || 0,
      totalCobrancas: payments.totalCount || 0,
      totalRecebido,
      totalPendente: totalPending,
      totalVencido: totalOverdue,
      ultimosClientes: (customers.data || []).slice(0, 5),
      ultimasCobrancas: (payments.data || []).slice(0, 5),
    });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, erro: 'Erro ao buscar dados do Asaas', detalhes: err?.response?.data || err.message });
  }
});

// 6) Cadastrar cliente na Asaas
app.post(
  '/api/asaas/cadastrar-cliente',
  auth,
  [
    body('name').isString().withMessage('name é obrigatório.').trim().escape(),
    body('email').optional().isEmail().normalizeEmail().withMessage('E-mail inválido.'),
    // Outras validações para cpfCnpj, phone, etc. podem ser adicionadas aqui
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ ok: false, erros: errors.array() });

    const userId = req.user.id;
    try {
      const asaasToken = await getAsaasTokenByUserId(userId);
      if (!asaasToken) return res.status(400).json({ ok: false, msg: 'Token Asaas não configurado.' });

      const payload = {
        name: xss(req.body.name),
        cpfCnpj: xss(req.body.cpfCnpj || ''),
        email: xss(req.body.email || ''),
        phone: xss(req.body.phone || ''),
        // Demais campos…
      };

      const { data: cliente } = await axios.post('https://www.asaas.com/api/v3/customers', payload, {
        headers: { access_token: asaasToken },
      });

      return res.json({ ok: true, cliente });
    } catch (err) {
      return res.status(500).json({ ok: false, msg: err.response?.data || err.message });
    }
  }
);

// 7) Gerar cobrança na Asaas
app.post(
  '/api/asaas/gerar-cobranca',
  auth,
  [
    body('customer').isString().withMessage('customer é obrigatório.').trim().escape(),
    body('value').isNumeric().withMessage('value deve ser número.'),
    body('billingType').optional().isString().trim().escape(),
    body('dueDate').optional().isISO8601().withMessage('dueDate deve ser data ISO.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ ok: false, erros: errors.array() });

    const userId = req.user.id;
    try {
      const asaasToken = await getAsaasTokenByUserId(userId);
      if (!asaasToken) return res.status(400).json({ ok: false, msg: 'Token Asaas não configurado.' });

      const payload = {
        customer: xss(req.body.customer),
        billingType: xss(req.body.billingType || 'BOLETO'),
        value: req.body.value,
        dueDate: req.body.dueDate || new Date().toISOString().split('T')[0],
      };

      const { data: cobranca } = await axios.post('https://www.asaas.com/api/v3/payments', payload, {
        headers: { access_token: asaasToken },
      });

      return res.json({ ok: true, cobranca });
    } catch (err) {
      return res.status(500).json({ ok: false, msg: err.response?.data || err.message });
    }
  }
);

// ===== ESQUEMA E ROTA PARA VINCULAR JWT ↔ NÚMERO =====

const TokenPorNumeroSchema = new mongoose.Schema({
  numero: { type: String, required: true, unique: true },
  jwt: { type: String, required: true },
  userId: { type: mongoose.Types.ObjectId, ref: 'Usuario', required: true },
});
const TokenPorNumero = mongoose.model('TokenPorNumero', TokenPorNumeroSchema);

app.post('/api/vincular-token-numero', auth, async (req, res) => {
  const { numero } = req.body;
  if (!numero) return res.status(400).json({ ok: false, msg: 'Número ausente' });

  try {
    const jwtToken = req.headers.authorization.split(' ')[1];
    const userId = req.user.id;

    const existente = await TokenPorNumero.findOne({ numero });
    if (existente) {
      existente.jwt = jwtToken;
      existente.userId = userId;
      await existente.save();
    } else {
      await new TokenPorNumero({ numero, jwt: jwtToken, userId }).save();
    }

    return res.json({ ok: true, msg: 'Número, JWT e userId vinculados com sucesso.' });
  } catch (err) {
    console.error('[server] /api/vincular-token-numero:', err);
    return res.status(500).json({ ok: false, msg: 'Erro ao vincular token ao número.' });
  }
});

app.post("/api/memoria", auth, async (req, res) => {
  const { numero, entry, name, phone, idade, ultimoagendamento, resumoDasInteracoes } = req.body;
  const userId = req.user.id;
  console.log("Payload do JWT:", req.user)


  // validação rápida
  if (
    !numero ||
    !entry ||
    !entry.from ||
    (entry.from !== "user" && entry.from !== "bot") ||
    !entry.text
  ) {
    return res.status(400).json({ ok: false, msg: "Corpo inválido para /api/memoria" });
  }

  try {
    // 1) procura documento já existente
    let doc = await Memoria.findOne({ numero, userId });
    if (!doc) {
      doc = new Memoria({
        numero,
        userId,
        history: [],
        profile: {}
      });
    }

    // 2) se vier name/phone/idade/resumoDasInteracoes, preenche profile (somente se ainda estiver vazio)
    if (name && !doc.profile.name) {
      doc.profile.name = xss(name);
    }
    if (phone && !doc.profile.phone) {
      doc.profile.phone = xss(phone);
    }
    if (idade && !doc.profile.idade) {
      doc.profile.idade = xss(idade);
    }
    if (ultimoagendamento in req.body) {
      doc.profile.ultimoagendamento = xss(ultimoagendamento);
    }
    
    if (resumoDasInteracoes) { 
      doc.profile.resumoDasInteracoes = xss(resumoDasInteracoes);
    }

    // 3) empurra a mensagem na fila history
    doc.history.push({
      from: entry.from,
      text: xss(entry.text),
      timestamp: entry.timestamp ? new Date(entry.timestamp) : new Date()
    });

    await doc.save();
    console.log("Salvo com sucesso:", doc.profile);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[POST /api/memoria]", err);
    return res.status(500).json({ ok: false, msg: "Erro interno ao salvar memória" });
  }
});


app.post("/api/memoria/atualizar-perfil", auth, async (req, res) => {
  const { numero, name, phone, idade, ultimoagendamento, resumoDasInteracoes } = req.body;
  const userId = req.user.id;

  if (!numero) {
    return res.status(400).json({ ok: false, msg: "Número é obrigatório." });
  }

  try {
    let doc = await Memoria.findOne({ numero, userId });

    if (!doc) {
      return res.status(404).json({ ok: false, msg: "Memória não encontrada." });
    }

    if (name) doc.profile.name = xss(name);
    if (phone) doc.profile.phone = xss(phone);
    if (idade) doc.profile.idade = xss(idade);
    if ("ultimoagendamento" in req.body) doc.profile.ultimoagendamento = xss(ultimoagendamento);
    if (resumoDasInteracoes) doc.profile.resumoDasInteracoes = xss(resumoDasInteracoes);
    console.log("req.body recebido:", req.body);

    await doc.save();
    console.log("Perfil atualizado:", doc.profile);
    return res.status(200).json({ ok: true, msg: "Perfil atualizado com sucesso" });
  } catch (err) {
    console.error("[POST /api/memoria/atualizar-perfil]", err);
    return res.status(500).json({ ok: false, msg: "Erro ao atualizar perfil." });
  }
});


// GET /api/memoria/:numero
app.get("/api/memoria/:numero", auth, async (req, res) => {
  const numero = req.params.numero;
  const userId = req.user.id;

  try {
    const doc = await Memoria.findOne({ numero, userId }).lean();
    if (!doc) {
      return res.status(404).json({ ok: false, msg: "Nenhuma memória encontrada para este número" });
    }
    return res.json({
      ok: true,
      history: doc.history,
      profile: doc.profile
    });
  } catch (err) {
    console.error("[GET /api/memoria/:numero]", err);
    return res.status(500).json({ ok: false, msg: "Erro ao buscar memória" });
  }
});

app.get("/api/token-por-numero/:numero", auth, async (req, res) => {
  const numero = req.params.numero;
  try {
    const registro = await TokenPorNumero.findOne({ numero }).lean();
    if (!registro) {
      return res.status(404).json({ ok: false, msg: "Número não vinculado" });
    }
    return res.json({ userId: registro.userId.toString() });
  } catch (err) {
    console.error("[GET /api/token-por-numero/:numero]", err);
    return res.status(500).json({ ok: false, msg: "Erro ao buscar token por número." });
  }
});


// ===== START SERVER =====
const PORT = process.env.PORT_BACKEND || 3001;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
