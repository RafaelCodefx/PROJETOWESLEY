import re

from datetime import datetime, timedelta, timezone
from fastapi import FastAPI, Header, HTTPException, Depends
from pydantic import BaseModel
from pathlib import Path
from typing import Optional, List, Dict
import requests
import json
import os

from elevenlabs import ElevenLabs, save
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from langchain_community.document_loaders import CSVLoader
from langchain_community.vectorstores import FAISS
from langchain.chains import ConversationalRetrievalChain
from langchain.memory import ConversationBufferMemory
from langchain.prompts import PromptTemplate
from langchain.schema import HumanMessage
from dotenv import load_dotenv


from datetime import date

# Cache simples em memória
numeros_registrados: dict[str, str] = {}


def tempo(dia: int, mes: int) -> str:
    hoje = date.today()
    print(hoje)
    if dia == hoje.day and mes == hoje.month:
        return "Hoje"
    # Verifica se é amanhã (mesmo mês e dia+1)
    elif dia == (hoje + timedelta(days=1)).day and mes == hoje.month:
        return "Amanhã"
    else:
        return f"{dia:02d}/{mes:02d}"


COLETANDO_NOME = "COLETANDO_NOME"
COLETANDO_CPF = "COLETANDO_CPF"
COLETANDO_TELEFONE = "COLETANDO_TELEFONE"

AGUARDANDO_ESCOLHA_HORARIO_FUTURO = "AGUARDANDO_ESCOLHA_HORARIO_FUTURO"

AGUARDANDO_CONFIRMACAO_UNICO_HORARIO = "AGUARDANDO_CONFIRMACAO_UNICO_HORARIO"
AGUARDANDO_ESCOLHA_HORARIO_HUMANO = "AGUARDANDO_ESCOLHA_HORARIO_HUMANO"


# ─── NOVO ESTADO PARA QUANDO O USUÁRIO INFORMAR APENAS DATA ────────────────────
AGUARDANDO_DATA_MANUAL = "AGUARDANDO_DATA_MANUAL"





# ─── CACHES GLOBAIS PARA MANTER OPÇÕES NUMERADAS E ESTADO ─────────────────────
cache_horarios_por_usuario: Dict[str, List[Dict[str, str]]] = {}
estado_por_usuario: Dict[str, str] = {}

# Guarda, para cada número de WhatsApp, o customerId já criado no Asaas
customerId_por_usuario: Dict[str, str] = {}

# Guarda temporariamente, durante o diálogo, os dados que o usuário vai informando (name, cpfCnpj, telefone)
dados_cliente_temp: Dict[str, Dict[str, str]] = {}


load_dotenv()
elevenlabs = ElevenLabs(api_key=os.getenv("ELEVENLABS_API_KEY"))

# ─── 1) Carregar base de conhecimento e vetorizar ──────────────────────────────
loader = CSVLoader(file_path="base_conhecimento.csv")
documents = loader.load()
embeddings = OpenAIEmbeddings()
db = FAISS.from_documents(documents, embeddings)

# ─── 2) Memória em RAM por usuário ─────────────────────────────────────────────
memorias_usuarios: Dict[str, ConversationBufferMemory] = {}

def get_memoria_por_usuario(numero_telefone: str) -> ConversationBufferMemory:
    if numero_telefone not in memorias_usuarios:
        memorias_usuarios[numero_telefone] = ConversationBufferMemory(
            memory_key="chat_history",
            return_messages=True
        )
    return memorias_usuarios[numero_telefone]

# ─── Função auxiliar para detectar DATA ou HORA no texto ────────────────────────
def contains_date_or_time(texto: str) -> bool:
    date_pattern = r"\d{4}-\d{2}-\d{2}"
    time_pattern = r"\d{2}:\d{2}"
    return bool(re.search(date_pattern, texto) or re.search(time_pattern, texto))

# ─── 3) Buscar config completa do usuário via JWT ───────────────────────────────
def get_user_config(token_jwt: str) -> dict:
    try:
        res = requests.get(
            "http://localhost:3001/api/get-config",
            headers={"Authorization": f"Bearer {token_jwt}"},
            timeout=10
        )
        if res.status_code == 200:
            return res.json() or {}
        elif res.status_code == 401:
            raise HTTPException(status_code=401, detail="Token inválido ou expirado")
        else:
            print(f"[WARN] /api/get-config retornou {res.status_code}: {res.text}")
            return {}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Falha ao buscar config: {e}")
        return {}

# ─── 4) Inicializar LLM dinâmico ───────────────────────────────────────────────
def get_llm(openai_key: str) -> ChatOpenAI:
    return ChatOpenAI(
        temperature=0.3,
        model="gpt-4-turbo",
        openai_api_key=openai_key or os.environ.get("OPENAI_API_KEY")
    )


def responder_duvida_rag(user_message, prompt_fluxo, db, openai_key, memoria=None):
    """
    Usa o RAG (base_conhecimento.csv) para responder dúvidas durante coleta de dados,
    e emenda com o prompt do fluxo.
    """
    # Opcional: pode passar a memoria do usuário, se quiser considerar contexto do chat
    llm = ChatOpenAI(temperature=0.6, model="gpt-4-turbo", openai_api_key=openai_key)
    prompt_template = PromptTemplate(
        input_variables=["context", "question"],
        template=(
            "Responda de forma clara, breve e amigável à dúvida do cliente. "
            "Use sempre que possível o contexto fornecido (se houver):\n\n"
            "{context}\n\n"
            "Pergunta do cliente:\n"
            "{question}\n\n"
            "Resposta direta e gentil:"
        )
    )
    qa_chain = ConversationalRetrievalChain.from_llm(
        llm=llm,
        retriever=db.as_retriever(),
        memory=memoria,   # pode passar None se não quiser histórico
        combine_docs_chain_kwargs={
            "prompt": prompt_template,
            "document_variable_name": "context"
        }
    )
    resposta_ia = qa_chain.invoke({"question": user_message})["answer"]
    return f"{resposta_ia.strip()}\n\n{prompt_fluxo}"



# ─── 5) Detecta comandos ASAAS simples (mantém mas não usado neste exemplo) ────
def is_asaas_command(msg: str) -> bool:
    palavras = [
        'boleto', 'cobrança', 'fatura',
        'criar cobrança', 'emitir boleto',
        'novo cliente', 'cadastrar cliente'
    ]
    return any(p in msg.lower() for p in palavras)

def handle_asaas_command(msg: str, token_jwt: str) -> Optional[str]:
    if "boleto" in msg.lower() or "cobrança" in msg.lower():
        valor = 300
        cliente_nome = "Cliente"
        try:
            res = requests.post(
                "http://localhost:3001/api/asaas/gerar-cobranca",
                json={"customer": cliente_nome, "value": valor},
                headers={"Authorization": f"Bearer {token_jwt}"}
            )
            if res.status_code == 200:
                cobranca = res.json()
                link = cobranca.get('bankSlipUrl') or cobranca.get('pixUrl', '')
                return f"Cobrança criada! Aqui está o link: {link}"
            else:
                return "Erro ao gerar cobrança. Tente novamente."
        except Exception as e:
            print(f"[ERROR] Falha ASAAS: {e}")
            return "Erro ao acessar o serviço financeiro. Tente mais tarde."
    return None

def extract_cpf(user_message: str) -> Optional[str]:
    """
    Tenta extrair um CPF (11 dígitos) ou CNPJ (14 dígitos) da mensagem.
    Remove pontos e traços caso sejam informados com pontuação.
    """
    texto_numeros = re.sub(r"[^\d]", "", user_message)
    if len(texto_numeros) == 11 or len(texto_numeros) == 14:
        return texto_numeros
    return None

# ─── 6) Geração de áudio com ElevenLabs ─────────────────────────────────────────
def gerar_audio(texto: str, nome_arquivo: str = "resposta.mp3") -> Optional[str]:
    try:
        audio = elevenlabs.text_to_speech.convert(
            text=texto,
            voice_id="yM93hbw8Qtvdma2wCnJG",
            model_id="eleven_multilingual_v2",
            output_format="mp3_44100_128",
        )
        AUDIO_DIR = "../Whats/audios"
        Path(AUDIO_DIR).mkdir(parents=True, exist_ok=True)
        caminho = os.path.join(AUDIO_DIR, nome_arquivo)
        save(audio, caminho)
        print(f"[AUDIO] Áudio gerado e salvo em: {caminho}")
        return f"audios/{nome_arquivo}"
    except Exception as e:
        print(f"[ERROR] Falha ao gerar áudio: {e}")
        return None
        # ─── 7) Detecta intenção via LLM ────────────────────────────────────────────────
def detect_intent_llm(user_message: str, openai_key: str) -> str:
    prompt = (
        "Você é um classificador de intenções. Dada a mensagem do cliente, responda exatamente uma das opções:\n"
        "- AGENDAR         (quando o usuário quer marcar um compromisso)\n"
        "- VERIFICAR       (quando o usuário quer saber horários disponíveis)\n"
        "- REAGENDAR       (quando o usuário quer remarcar um compromisso)\n"
        "- CANCELAR        (quando o usuário quer cancelar um compromisso)\n"
        "- OUTRO           (qualquer outra coisa)\n\n"
        f"Mensagem do cliente: \"{user_message}\"\n"
        "Classificação:"
    )
    llm = ChatOpenAI(
        temperature=0.0,
        model="gpt-4.1-nano",
        openai_api_key=openai_key
    )
    response = llm([HumanMessage(content=prompt)])
    intent = response.content.strip().upper()
    valid_intents = {"AGENDAR", "VERIFICAR", "REAGENDAR", "CANCELAR"}
    return intent if intent in valid_intents else "OUTRO"

def chamar_ia_para_responder(user_message, openai_key):
    prompt = (
        "Responda de forma breve, amigável e natural à dúvida abaixo. Seja direto e ajude o cliente, sem dar respostas técnicas demais.\n"
        f"Pergunta do cliente: {user_message}\n"
        "Resposta:"
    )
    llm = ChatOpenAI(temperature=0.6, model="gpt-4-turbo", openai_api_key=openai_key)
    return llm([HumanMessage(content=prompt)]).content.strip()


# ─── 8) Extração de nome e telefone da frase (é chamada pelo endpoint) ─────────
def extract_name_and_phone_llm(user_message: str, openai_key: str) -> dict:
   
    prompt = f"""
Você é um assistente que extrai nome e telefone de uma mensagem.
Somente capture o nome se a pessoa estiver claramente se identificando.
Ignore nomes de atendentes como "Rafael", "Doutora Ana", etc.

Retorne JSON com as chaves: "name" e "phone". Se não houver, coloque null.

Mensagem: \"{user_message}\"
"""

    llm = ChatOpenAI(model="gpt-3.5-turbo", temperature=0, openai_api_key=openai_key)
    response = llm.invoke([HumanMessage(content=prompt)])
    content = response.content.strip()

    try:
        parsed = json.loads(content)
        print("extração de nome e phone: " , parsed)
        return parsed if "name" in parsed and "phone" in parsed else {"name": None, "phone": None}
    except:
        return {"name": None, "phone": None}



def criar_cliente_asaas_sandbox(nome: str, cpfCnpj: str, mobilePhone: str, asaasToken: str) -> Optional[str]:
    """
    Chama o endpoint do Asaas (sandbox) para criar um cliente.
    Retorna o customerId (ex: "cus_abcdef1234") ou None se falhar.
    """
    # Endpoint de sandbox do Asaas:
    url = "https://sandbox.asaas.com/api/v3/customers"
    payload = {
        "name": nome,
        "cpfCnpj": cpfCnpj,
        "email": None,
        "mobilePhone": mobilePhone,
        # Se quiser, pode incluir outros campos opcionais:
        # "phone": telefone, "address": "...", etc.
    }
    try:
        resp = requests.post(
            url,
            json=payload,
            headers={
                "access_token": asaasToken,
                "Content-Type": "application/json"
            },
            timeout=10
        )
        if resp.status_code in (200, 201):
            data = resp.json()
            return data.get("id")
        else:
            print("[ASAAS ERRO]", resp.status_code, resp.text)
            return None
    except Exception as e:
        print("[ERROR criar_cliente_asaas]", e)
        return None

def gerar_cobranca_asaas_sandbox(customerId: str, valor: float, asaasToken: str) -> Optional[str]:
    """
    Chama o endpoint do Asaas (sandbox) para gerar uma cobrança (boleto/Pix).
    Retorna o link de pagamento (bankSlipUrl ou pixUrl) ou None se falhar.
    """
    url = "https://sandbox.asaas.com/api/v3/payments"
    payload = {
        "customer": customerId,
        "billingType": "BOLETO",    # ou "PIX"
        "value": valor,
        "dueDate": datetime.utcnow().strftime("%Y-%m-%d")
    }
    try:
        resp = requests.post(
            url,
            json=payload,
            headers={
                "access_token": asaasToken,
                "Content-Type": "application/json"
            },
            timeout=10
        )
        if resp.status_code == 200:
            data = resp.json()
            return data.get("bankSlipUrl") or data.get("pixUrl", None)
    except Exception as e:
        print("[ERROR gerar_cobranca_asaas]", e)
    return None


def choose_slot_with_llm(
    user_message: str,
    slots_cache: List[str],
    openai_key: str
) -> Optional[int]:
    """
    Monta um prompt com os horários disponíveis (slots_cache) e
    pergunta ao LLM qual deles o usuário escolheu. Retorna o índice
    do slot selecionado ou None se não for possível entender.
    """
    # Formata cada slot para o modelo entender: "1) 05/06 às 07:00", etc.
    friendly_list = []
    for idx, iso_str in enumerate(slots_cache, start=1):
        data, hora = iso_str.split(" ")
        dia, mes = data.split("-")[2], data.split("-")[1]
        friendly = f"{dia}/{mes} às {hora}"
        friendly_list.append(f"{idx}) {friendly}")
    # Monta o prompt
    prompt = (
        "Você é um assistente que recebe uma mensagem de um cliente e uma lista de horários disponíveis.\n"
        "Retorne **apenas** o número do horário que o cliente escolheu (por exemplo: 1 ou 2 ou 3), ou retorne 'NÃO_ENTENDI' se não conseguir.\n\n"
        f"Horários disponíveis:\n" +
        "\n".join(friendly_list) +
        "\n\n"
        f"Mensagem do cliente: \"{user_message}\"\n"
        "Resposta (apenas número ou 'NÃO_ENTENDI'):"
    )
    llm = ChatOpenAI(temperature=0.0, model="gpt-3.5-turbo", openai_api_key=openai_key or os.environ.get("OPENAI_API_KEY"))
    resposta = llm([HumanMessage(content=prompt)]).content.strip()
    # Tenta converter para inteiro
    try:
        idx = int(resposta)
        if 1 <= idx <= len(slots_cache):
            return idx - 1  # retorna índice 0-based
    except:
        pass
    return None

def salvar_memoria(numero, mensagem, token, name=None, phone=None, idade=None, resumo=None):
    url = "http://localhost:3001/api/memoria"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    payload = {
        "numero": numero,
        "entry": {
            "from": "user",  # ou "bot", dependendo do contexto
            "text": mensagem
        }
    }
    # Só adiciona se vier
    if name: payload["name"] = name
    if phone: payload["phone"] = phone
    if idade: payload["idade"] = idade
    if resumo: payload["resumoDasInteracoes"] = resumo

    resp = requests.post(url, headers=headers, json=payload)
    return resp.json()

def extrair_nome_com_llm(mensagem, openai_key):
    prompt = f"""
Você é um assistente de atendimento. Extraia APENAS o nome do cliente se ele se apresentar (ex: "meu nome é...", "sou...", "me chamo...").
Se o nome mencionado não for apresentação (ex: "Olá Rafael", "Oi Doutora Carla"), retorne "NÃO INFORMADO".
Frase do cliente: "{mensagem}"
Nome extraído:"""
    response = openai.Completion.create(
        engine="gpt-3.5-turbo",  # ou outro modelo
        prompt=prompt,
        max_tokens=10,
        temperature=0,
        stop=["\n"]
    )
    return response.choices[0].text.strip()


# ─── 9) Salvar memória no banco (também chamado pelo endpoint) ─────────────────
def save_memory_to_db(
    numero: str,
    who: str,
    text: str,
    token_jwt: str,
    name: Optional[str] = None,
    phone: Optional[str] = None,
    idade: Optional[str] = None,
    resumoDasInteracoes: Optional[str] = None
):

    payload = {
        "numero": numero,
        "entry": {
            "from": who,
            "text": text,
            "timestamp": datetime.utcnow().isoformat()
        },
        **({"name": name} if name else {}),
        **({"phone": phone} if phone else {}),
        **({"idade": idade} if idade else {}),
        **({"resumoDasInteracoes": resumoDasInteracoes} if resumoDasInteracoes else {})
    }

    try:
        requests.post(
            "http://localhost:3001/api/memoria",
            json=payload,
            headers={"Authorization": f"Bearer {token_jwt}"}
        )
        print("payload: ", payload)

    except Exception as e:
        print(f"[ERRO] Ao salvar memória: {e}")

# ─── 10) Utilitários de tempo, formatação e extração de data/hora ──────────────
def get_current_datetime_aware_utc() -> datetime:
    return datetime.utcnow().replace(tzinfo=timezone.utc)

def extract_datetime(user_message: str, openai_key: str) -> Optional[dict]:
    prompt = (
        "Você é um assistente que identifica data e hora em linguagem natural. "
        "Dada a frase abaixo, extraia a data (no formato YYYY-MM-DD) e a hora (no formato HH:MM) "
        "que o usuário quer agendar. Se faltar data, retorne apenas 'NÃO_DATA'. "
        "Se faltar hora, retorne apenas 'NÃO_HORA'. "
        "Se não houver data nem hora, retorne 'NÃO_ENCONTROU'.\n\n"
        f"Frase: \"{user_message}\"\n\n"
        "Saída esperada (JSON ou texto):\n"
        "{\n"
        '  "date": "YYYY-MM-DD",\n'
        '  "time": "HH:MM"\n'
        "}\n"
        "ou apenas:\n"
        "NÃO_DATA\n"
        "NÃO_HORA\n"
        "NÃO_ENCONTROU"
    )

    llm = ChatOpenAI(
        temperature=0.0,
        model="gpt-4.1-nano",
        openai_api_key=openai_key or os.environ.get("OPENAI_API_KEY")
    )
    response = llm([HumanMessage(content=prompt)])
    text = response.content.strip()

    if text.upper() == "NÃO_ENCONTROU":
        return None
    if text.upper() in {"NÃO_DATA", "NÃO_HORA"}:
        return {"date": None, "time": None}

    try:
        data = json.loads(text)
        return {
            "date": data.get("date"),
            "time": data.get("time")
        }
    except json.JSONDecodeError:
        return None

def inferir_periodo_dia(user_message: str) -> Optional[str]:
    texto = user_message.lower()
    if any(p in texto for p in ["manhã", "manha", "cedo"]):
        return "manha"
    if "tarde" in texto:
        return "tarde"
    if any(p in texto for p in ["noite", "à noite", "de noite", "no final do dia"]):
        return "noite"
    return None

def horario_esta_no_periodo(iso: str, periodo: str) -> bool:
    hora = int(iso.split("T")[1][:2])
    if periodo == "manha":
        return 7 <= hora < 12
    elif periodo == "tarde":
        return 12 <= hora < 18
    elif periodo == "noite":
        return hora >= 18
    return True


def get_current_date_brasilia() -> str:
    agora_utc = datetime.utcnow().replace(tzinfo=timezone.utc)
    horario_brasilia = agora_utc - timedelta(hours=3)
    return horario_brasilia.strftime("%Y-%m-%d")

def formatar_humano(slot_iso: str) -> str:
    data, hora = slot_iso.split(" ")
    ano, mes, dia = data.split("-")
    return f"{dia}/{mes} às {hora}"

def analyze_user_for_scheduling(user_message: str, openai_key: str) -> dict:
    now = get_current_datetime_aware_utc()
    name_phone = extract_name_and_phone_llm(user_message, openai_key=openai_key or os.environ.get("OPENAI_API_KEY"))
    print(name_phone)
    date = None
    time = None
    needs_date = True
    needs_time = True

    try:
        slots = extract_date_e_periodo(user_message, openai_key)
    except Exception:
        slots = None

    if slots:
        if slots.get("date"):
            date = slots["date"]
            needs_date = False
        if slots.get("time"):
            time = slots["time"]
            needs_time = False

    needs_slots = True if date is None else (needs_date or needs_time)

    return {
        "current_datetime": now,
        "has_name": bool(name_phone["name"]),
        "name": name_phone["name"],
        "has_phone": bool(name_phone["phone"]),
        "phone": name_phone["phone"],
        "date": date,
        "time": time,
        "needs_date": needs_date,
        "needs_time": needs_time,
        "needs_slots": needs_slots
    }


def decode_token_completo(authorization: str = Header(...)) -> tuple[str, str]:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Token inválido")

    token = authorization.replace("Bearer ", "")

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=ALGORITHMS)
        numero_ = payload.get("numero")
        if not numero:
            raise HTTPException(status_code=400, detail="Número ausente no token")
        return numero, token  # ← agora retorna os dois
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expirado")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Token inválido")


def get_user_id_por_numero(numeroConectado: str, token_jwt: str) -> Optional[str]:
    try:
        resp = requests.get(
            f"http://localhost:3001/api/token-por-numero/{numeroConectado}",
            headers={"Authorization": f"Bearer {token_jwt}"}
        )
        print("status_code, responde_text e numero_telefone: ", resp.status_code, resp.text, numero)
        if resp.status_code == 200:
            user_id = resp.json().get("userId")
            print("userId extraído:", user_id)
            return resp.json().get("userId")
    
    except:
        pass
    return None

def get_name_from_db(numero: str, token_jwt: str) -> Optional[str]:
    """
    Função auxiliar para buscar o nome salvo na memória do usuário (profile.name).
    """
    try:
        resp = requests.get(
            f"http://localhost:3001/api/memoria/{numero}",
            headers={"Authorization": f"Bearer {token_jwt}"}
        )
        if resp.status_code == 200:
            data = resp.json()
            return data.get("profile", {}).get("name")
    except:
        pass
    return None



def detectar_troca_data(
    user_message: str,
    openai_key: str
) -> Optional[str]:
    """
    Usa a LLM para entender se o usuário está rejeitando o horário atual e
    sugerindo uma outra data. Se detectar algo como "dia 09/06" ou "no dia 2025-06-09",
    retorna a data em "YYYY-MM-DD". Caso contrário, retorna None.
    """
    prompt = f"""
Você é um assistente que recebe frases de um cliente que acabou de recusar um horário
e possivelmente indica "quero outro dia". Sua tarefa é DESTE modo:

Se o cliente disser algo como “Não posso hoje, pode ser dia 09/06/2025?” ou
“hoje não, que tal 2025-06-09?”, você deve extrair e retornar exatamente a data no
formato ISO “YYYY-MM-DD”, sem aspas. Exemplo: “2025-06-09”.

Se não houver nenhum indício claro de que ele está sugerindo outro dia, ou não conseguir
extrair uma data válida, retorne “NÃO_ENTENDI”.

Mensagem do cliente: "{user_message}"
Resposta (só data ISO ou “NÃO_ENTENDI”):
"""
    llm = ChatOpenAI(temperature=0.0, model="gpt-4.1-nano", openai_api_key=openai_key)
    resposta = llm([HumanMessage(content=prompt)]).content.strip()

    # Se LLM devolveu “NÃO_ENTENDI”, retornamos None
    if resposta.upper() == "NÃO_ENTENDI":
        return None

    # Caso contrário, assumimos que devolveu algo como "2025-06-09"
    # (poderíamos adicionar um regex para garantir o formato ISO)
    if re.match(r"^\d{4}-\d{2}-\d{2}$", resposta):
        return resposta

    return None

import math


def extract_date_e_periodo(user_message: str, openai_key: str) -> Optional[Dict[str, str]]:
    agora = datetime.now()
    ano_atual = agora.year

    prompt = f"""
Você é um assistente que entende linguagem natural e extrai **duas informações** de frases de usuários:
1. A **data** (no formato YYYY-MM-DD).
2. O **período do dia**, se mencionado: manhã, tarde ou noite.

Você deve considerar:
- Frases como "segunda de manhã", "terça à tarde", "hoje à noite", etc.
- Se for mencionado apenas o dia ("segunda"), assuma a próxima ocorrência futura.
- Se o usuário disser "amanhã", converta para a data UTC correta.
- Se o período não for mencionado, retorne `null` para o campo `periodo`.

Ano atual: {ano_atual}

Exemplos:
"tenho disponibilidade na próxima segunda à tarde" =>
{{ "date": "2025-06-10", "periodo": "tarde" }}

"posso hoje de manhã" =>
{{ "date": "2025-06-08", "periodo": "manha" }}

"dia 18/12" =>
{{ "date": "2025-12-18", "periodo": null }}

"sexta" =>
{{ "date": "2025-06-13", "periodo": null }}

---

Frase do usuário:
\"\"\"{user_message}\"\"\"

Responda estritamente em JSON com as chaves `date` e `periodo` (ou `null` para período).
Formato:
{{ "date": "YYYY-MM-DD", "periodo": "manha" | "tarde" | "noite" | null }}
"""

    llm = ChatOpenAI(
        temperature=0.0,
        model="gpt-4-turbo",
        openai_api_key=openai_key
    )
    resposta = llm([HumanMessage(content=prompt)]).content.strip()

    try:
        data_dict = json.loads(resposta)
        return data_dict
    except Exception:
        print(f"[ERRO] JSON inválido do LLM: {resposta}")
        return None

def is_question(user_message: str) -> bool:
    """
    Retorna True se a mensagem do usuário parece uma pergunta (inclui '?' ou começa com palavra interrogativa).
    """
    perguntas = ["como", "por que", "quando", "onde", "quem", "posso", "tenho", "tem", "preciso", "será"]
    msg = user_message.lower().strip()
    if "?" in msg:
        return True
    return any(msg.startswith(p) for p in perguntas)

def escolher_slot_com_llm(
    user_message: str,
    slots_cache: List[Dict[str, str]],
    openai_key: str
) -> Optional[int]:
    if not slots_cache:
        return None

    friendly_list = []
    for idx, slot in enumerate(slots_cache, start=1):
        inicio_iso = slot["inicio"]
        partes = inicio_iso.split("T")
        data_parte = partes[0]
        hora_parte = partes[1][:5]
        dia, mes = data_parte.split("-")[2], data_parte.split("-")[1]
        friendly_list.append(f"{idx}) {dia}/{mes} às {hora_parte}")

    # Prompt com exemplos para naturalidade
    prompt = (
        "Você é uma atendente mulher simpática e eficiente que conversa com clientes no WhatsApp para agendar horários.\n"
        "Recebe uma lista numerada de horários disponíveis e a resposta do cliente. Mesmo que a mensagem seja informal, você deve entender qual horário ele está aceitando.\n"
        "Responda apenas com o número correspondente (1, 2, 3...). Se não entender, escreva 'NÃO_ENTENDI'.\n\n"

        "Exemplos:\n"
        "Horários disponíveis:\n1) 09/06 às 14:00\nMensagem do cliente: \"Pode ser sim, Wesley!\"\nResposta: 1\n\n"
        "Horários disponíveis:\n1) 09/06 às 14:00\nMensagem do cliente: \"Marca esse pra mim então 💖\"\nResposta: 1\n\n"
        "Horários disponíveis:\n1) 09/06 às 14:00\n2) 09/06 às 15:00\nMensagem do cliente: \"Prefiro o das 15h\"\nResposta: 2\n\n"
        "Horários disponíveis:\n1) 09/06 às 14:00\n2) 09/06 às 15:00\nMensagem do cliente: \"Tanto faz, escolhe pra mim\"\nResposta: NÃO_ENTENDI\n\n"

        "Agora, com base nisso:\n"
        "Horários disponíveis:\n" + "\n".join(friendly_list) +
        "\n\nMensagem do cliente: \"" + user_message + "\"\n"
        "Resposta (apenas o número ou 'NÃO_ENTENDI'):"
    )

    llm = ChatOpenAI(temperature=0.0, model="gpt-4.1-nano", openai_api_key=openai_key)
    resposta = llm([HumanMessage(content=prompt)]).content.strip()

    try:
        escolh = int(resposta)
        if 1 <= escolh <= len(slots_cache):
            return escolh - 1
    except:
        pass
    return None


def obter_e_formatar_horarios_futuros(
    date_iso: str,
    token_jwt: str,
    openai_key: str
) -> (List[Dict[str, str]], str):
    """
    1) Chama GET /api/horarios-disponiveis-por-dia?date={date_iso}
    2) Calcula 40% (arredondado para cima) da lista retornada.
    3) Retorna:
       - slots_reduzidos: os primeiros N slots (cada item: {"id": ..., "inicio": "YYYY-MM-DDTHH:MM:SS-03:00"})
       - texto: string com “📅 Para {DD/MM}, tenho: X, Y e Z. Qual escolhe?”
    """
    try:
        resp = requests.get(
            f"http://localhost:3001/api/horarios-disponiveis-por-dia?date={date_iso}",
            headers={"Authorization": f"Bearer {token_jwt}"},
            timeout=5
        )
        if resp.status_code != 200:
            return [], f"😔 Não consegui buscar horários para {date_iso}. Pode tentar outra data?"
        data = resp.json()
        todos_slots = data.get("disponiveis", [])
    except Exception as e:
        print(f"[ERRO] ao buscar horários futuros: {e}")
        return [], f"😔 Erro ao conectar ao serviço. Tente novamente."

    if not todos_slots:
        dd, mm = date_iso.split("-")[2], date_iso.split("-")[1]
        return [], f"😔 Não há horários livres em {dd}/{mm}. Pode tentar outra data?"

    # Calcular quantos são 40%
    qtd_total = len(todos_slots)
    qtd_para_exibir = max(1, math.ceil(qtd_total * 0.4))

    selecionados = todos_slots[:qtd_para_exibir]

    # Montar texto humano (“DD/MM às HH:MM”)
    friendly = []
    for h in selecionados:
        iso = h["inicio"]  # “2025-06-09T14:00:00-03:00”
        data_partes, hora_partes = iso.split("T")
        dia, mes = data_partes.split("-")[2], data_partes.split("-")[1]
        hora = hora_partes[:5]
        friendly.append(f"{dia}/{mes} às {hora}")

    if len(friendly) == 1:
        texto = f"📅 Para {dia}/{mes} só tenho {friendly[0]} disponível 😊 . Posso agendar nesse horario?"
    else:
        # “X, Y e Z”
        if len(friendly) == 2:
            frase = f"{friendly[0]} e {friendly[1]}"
        else:
            frase = ", ".join(friendly[:-1]) + f" e {friendly[-1]}"
        texto = f"📅 Para {dia}/{mes} tenho os horários {frase} 😊 Qual deles você tem maior preferencia?"

    return selecionados, texto


def gerar_resposta_natural(
    user_message: str,
    estado: str,
    cliente_nome: Optional[str],
    data_desejada: Optional[str],
    horarios_friendly: Optional[List[str]],
    openai_key: str
) -> str:
    """
    Monta um prompt para o LLM reescrever a resposta de forma humana, 
    levando em conta:
      - Mensagem original do usuário (user_message)
      - Estado atual do fluxo (estado)
      - Nome do cliente, se disponível
      - Data que foi inferida/selecionada, se houver (YYYY-MM-DD)
      - Lista de horários já formatados para exibição (por ex: ["09/06 às 14:00", "09/06 às 16:00"])
    O LLM deve devolver apenas o texto final "humano".
    """
    # Formata a lista de horários como string única, se houver
    slot_str = ""
    if horarios_friendly:
        if len(horarios_friendly) == 1:
            slot_str = horarios_friendly[0]
        else:
            # ex: "09/06 às 14:00 e 09/06 às 16:00" ou "09/06 às 14:00, 09/06 às 16:00 e 09/06 às 17:00"
            if len(horarios_friendly) == 2:
                slot_str = f"{horarios_friendly[0]} e {horarios_friendly[1]}"
            else:
                slot_str = ", ".join(horarios_friendly[:-1]) + f" e {horarios_friendly[-1]}"

    prompt = f"""
Você é uma atendente virtual amigável e fala de forma **bem natural**, usando emojis moderadamente (por exemplo, 😊, 📅, 👍, entre outros aja como uma atendente feminina), sem parecer um bot técnico. 

Dado:
- Mensagem do cliente: "{user_message}"
- Estado atual do atendimento: {estado}
- Nome do cliente (se souber): "{cliente_nome}"
- Data inferida ou selecionada (YYYY-MM-DD), se aplicável: "{data_desejada}"
- Horários disponíveis formatados para exibição (ex.: ["09/06 às 14:00", "09/06 às 16:00"]), se houver: "{slot_str}"

**Tarefa**: Gere exatamente a **única** mensagem que deve ser enviada ao cliente.  
- Se `estado` = "AGUARDANDO_ESCOLHA_HORARIO_HUMANO", apresente as opções de `slot_str` e pergunte “qual funciona melhor para você?”, de forma humana.  
- Se for confirmar único horário, pergunte algo como “Esse {slot_str} funciona para você?”  
- Se “não há vagas”, diga algo empático como “Poxa, não achei nenhum horário nessa data. Prefere tentar outro dia?”  
- Se for coletar CPF, telefone, etc., sua mensagem deve soar como um ser humano gentil pedindo a informação.  
- **NÃO** exponha datas no formato ISO “2025-06-09”; em vez disso, converta para “09/06/2025” dentro do prompt ou deixe o LLM perguntar “Para qual data (por exemplo, 09/06)?”
- Use `prompt_instrucoes` apenas para guiar o “tom geral” (você pode incluir isso no prompt se quiser).

Retorne apenas a mensagem final, sem nenhum JSON.
"""
    print("Estado: ", estado)
    llm = ChatOpenAI(temperature=0.7, model="gpt-4-turbo", openai_api_key=openai_key)
    resposta = llm([HumanMessage(content=prompt)]).content.strip()
    return resposta


# ─── 11) Função principal de resposta (usa cache/estado para não “escapar” do fluxo) ───────────────────────────────────────────
def generate_response(numero_telefone: str, user_message: str, token_jwt: str) -> dict:
    memoria = get_memoria_por_usuario(numero_telefone)
    nome_salvo = get_name_from_db(numero_telefone, token_jwt)



    if numero_telefone not in estado_por_usuario:
        estado_por_usuario[numero_telefone] = "INICIAL"

    prompt_instrucoes = get_user_config(token_jwt).get(
        'customInstructions',
        "Você é um atendente virtual amigável e eficiente 😊"
    )
    openai_key = (
        get_user_config(token_jwt).get('openaiKey')
        or os.environ.get("OPENAI_API_KEY")
    )

    estado_atual = estado_por_usuario[numero_telefone]
    print("estado atual: ", estado_atual)


 
    if estado_atual == COLETANDO_NOME:
        nome_informado = user_message.strip()
        if is_question(nome_informado):
            texto_fluxo = "😊 Agora, para continuar a emissão do boleto, poderia me informar seu **nome completo**?"
            return {
                "response": responder_duvida_rag(
                    user_message, texto_fluxo, db, openai_key, memoria=get_memoria_por_usuario(numero_telefone)
                ),
                "audio_path": None,
                "slots": []
            }

        # Fluxo normal (sem dúvida)
        if len(nome_informado) < 3:
            return {"response": "❌ Nome muito curto. Por favor, informe seu **nome completo**, por exemplo: \"João da Silva\".", "audio_path": None, "slots": []}

        dados_cliente_temp[numero_telefone] = {"name": nome_informado}
        estado_por_usuario[numero_telefone] = COLETANDO_CPF
        return {"response": "Ótimo, obrigado. Agora envie seu CPF ou CNPJ (somente números, sem pontos ou traços).", "audio_path": None, "slots": []}




    # Se estivermos aguardando o CPF/CNPJ:
    if estado_atual == COLETANDO_CPF:
        msg = user_message.strip()
        if is_question(msg):
            texto_fluxo = (
                "😊 Agora, para continuar, preciso do seu CPF ou CNPJ (apenas números, ex: \"12345678901\" ou \"12345678000199\")."
            )
            return {
                "response": responder_duvida_rag(
                    msg, texto_fluxo, db, openai_key, memoria=get_memoria_por_usuario(numero_telefone)
                ),
                "audio_path": None,
                "slots": []
            }

        cpf_informado = extract_cpf(msg)
        if not cpf_informado:
            return {
                "response": "❌ CPF/CNPJ inválido. Digite apenas os números, por exemplo: \"12345678901\" (11 dígitos) para CPF ou \"12345678000199\" (14 dígitos) para CNPJ.",
                "audio_path": None,
                "slots": []
            }

        # Salva o CPF/CNPJ informado
        dados_cliente_temp[numero_telefone]["cpfCnpj"] = cpf_informado

        # --- Obtém telefone do parâmetro e padroniza com '9' se necessário ---
        def formatar_mobile_phone(numero_telefone):
            # Remove tudo que não é número
            fone = re.sub(r'\D', '', numero_telefone)

            # Remove DDI (55) se tiver
            if fone.startswith('55') and len(fone) > 11:
                fone = fone[2:]

            # Garante no máximo 10 dígitos
            return fone[:10]
        fone = formatar_mobile_phone(numero_telefone)

        dados_cliente_temp[numero_telefone]["mobilePhone"] = fone
        # Agora já pode criar o cliente direto ou seguir o fluxo do Asaas
        # Exemplo:
        asaasToken = get_user_config(token_jwt).get("asaasKey")
        print("asaasToken: " , asaasToken)
        if not asaasToken:
            estado_por_usuario[numero_telefone] = "INICIAL"
            return {
                "response": "⚠️ Não encontrei sua chave Asaas. Por favor, configure-a no painel antes de continuar.",
                "audio_path": None,
                "slots": []
            }

        info_temp = dados_cliente_temp[numero_telefone]
        novo_customer_id = criar_cliente_asaas_sandbox(
            nome=info_temp["name"],
            cpfCnpj=info_temp["cpfCnpj"],
            mobilePhone=info_temp["mobilePhone"],
            asaasToken=asaasToken
        )
        print("info_temp: ", info_temp, novo_customer_id)

        if not novo_customer_id:
            # falhou ao criar no Asaas
            estado_por_usuario[numero_telefone] = "INICIAL"
            dados_cliente_temp.pop(numero_telefone, None)
            return {
                "response": "😔 Não consegui cadastrar para enviar o boleto. Verifique seus dados e tente novamente mais tarde.",
                "audio_path": None,
                "slots": []
            }

        # Salvamos em memória (ou no banco) esse customerId para futuras cobranças
        customerId_por_usuario[numero_telefone] = novo_customer_id
        dados_cliente_temp.pop(numero_telefone, None)
        estado_por_usuario[numero_telefone] = "INICIAL"

        return {
            "response": f"✅ Cliente cadastrado com sucesso! ID: {novo_customer_id}. Agora posso gerar seu boleto quando você pedir.",
            "audio_path": None,
            "slots": []
        }


    # Se estivermos aguardando o telefone:
    if estado_atual == COLETANDO_TELEFONE:
        # Tenta extrair apenas dígitos
        tel = re.sub(r"[^\d]", "", user_message)
        if len(tel) not in (10, 11):
            return {"response": "❌ Número inválido. Digite apenas os dígitos, ex: \"11988887766\" (11 dígitos).", "audio_path": None, "slots": []}

        dados_cliente_temp[numero_telefone]["telefone"] = tel

        # Agora temos name, cpfCnpj e telefone: podemos criar o cliente no Asaas sandbox
        asaasToken = get_user_config(token_jwt).get("asaasKey")
        if not asaasToken:
            estado_por_usuario[numero_telefone] = "INICIAL"
            return {"response": "⚠️ Não encontrei sua chave Asaas. Por favor, configure-a no painel antes de continuar.", "audio_path": None, "slots": []}

        info_temp = dados_cliente_temp[numero_telefone]
        novo_customer_id = criar_cliente_asaas_sandbox(
            nome=info_temp["name"],
            cpfCnpj=info_temp["cpfCnpj"],
            telefone=info_temp["telefone"],
            asaasToken=asaasToken
        )

        if not novo_customer_id:
            # falhou ao criar no Asaas
            estado_por_usuario[numero_telefone] = "INICIAL"
            dados_cliente_temp.pop(numero_telefone, None)
            return {"response": "😔 Não consegui cadastrar no Asaas. Verifique seus dados e tente novamente mais tarde.", "audio_path": None, "slots": []}

        # Salvamos em memória (ou no banco) esse customerId para futuras cobranças
        customerId_por_usuario[numero_telefone] = novo_customer_id
        dados_cliente_temp.pop(numero_telefone, None)
        estado_por_usuario[numero_telefone] = "INICIAL"

        return {"response": f"✅ Cliente cadastrado com sucesso! ID: {novo_customer_id}. Agora posso gerar seu boleto quando você pedir.", "audio_path": None, "slots": []}




    if estado_atual == AGUARDANDO_ESCOLHA_HORARIO_FUTURO:
        recebido = user_message.strip()
        slots_cache = cache_horarios_por_usuario.get(numero_telefone, [])

        escolhido_idx = escolher_slot_com_llm(recebido, slots_cache, openai_key)
        if escolhido_idx is not None:
            slot_escolhido = slots_cache[escolhido_idx]
            event_id = slot_escolhido["id"]
            inicio_iso = slot_escolhido["inicio"]  # “2025-06-09T14:00:00-03:00”
            partes = inicio_iso.split("T")
            data_parte, hora_parte = partes[0], partes[1][:5]
            dt_iso = f"{data_parte}T{hora_parte}:00-03:00"
            data_evento = datetime.fromisoformat(dt_iso)
            data_fim = data_evento + timedelta(minutes=60)

            cliente_nome = get_name_from_db(numero_telefone, token_jwt) or "Cliente"

            # Criar novo evento (POST) em vez de editar; ou, se quiser editar um placeholder:
            payload = {
                "id":      event_id,
                "summary": f"Atendimento {cliente_nome}",
                "start":   {"dateTime": data_evento.isoformat()},
                "end":     {"dateTime": data_fim.isoformat()},
                "colorId": "10"
            }
            # Supondo que você tenha uma rota POST /api/google/criar-evento:
            resp = requests.post(
                "http://localhost:3001/api/google/criar-evento",
                json=payload,
                headers={"Authorization": f"Bearer {token_jwt}"}
            )

            if resp.status_code in (200, 201):
                dia, mes = data_parte.split("-")[2], data_parte.split("-")[1]
                texto = f"✅ Pronto, {cliente_nome}! Seu atendimento está marcado para {dia}/{mes} às {hora_parte} 😊"
                # A partir daqui, continue com fluxo de cobrança (Asaas) ou dados faltantes.
            else:
                texto = "😔 Ops, não consegui criar o compromisso. Tente novamente mais tarde."

            cache_horarios_por_usuario.pop(numero_telefone, None)
            estado_por_usuario[numero_telefone] = "INICIAL"
            caminho_audio = None if contains_date_or_time(texto) else gerar_audio(texto, f"{numero_telefone}.mp3")
            return {"response": texto, "audio_path": caminho_audio, "slots": []}

        # Se LLM não entender qual slot:
        texto = (
            "🤔 Não consegui identificar qual horário você pediu. "
            "Digite algo como “1” ou “o segundo horário”, por favor."
        )
        return {"response": texto, "audio_path": None, "slots": []}


      # ─── Estado “AGUARDANDO_CONFIRMACAO_AMANHA” ───────────────────────────────────
    if estado_atual == "AGUARDANDO_CONFIRMACAO_AMANHA":
        texto = user_message.strip()

        # 1) Primeiro, tentamos extrair uma DATA (YYYY‐MM‐DD) ou expressão natural
        info = extract_date_e_periodo(texto, openai_key)
        data_desejada = info["date"] if info else None
        periodo_desejado = info["periodo"] if info else None


        if data_desejada:
            # “data_desejada” já é uma string "YYYY-MM-DD"
            try:
                resp_api_data = requests.get(
                    f"http://localhost:3001/api/horarios-disponiveis?date={data_desejada}",
                    headers={"Authorization": f"Bearer {token_jwt}"}, timeout=5
                )
                todos_slots = resp_api_data.status_code == 200 and resp_api_data.json().get("horarios", []) or []
            except Exception as e:
                print(f"[ERROR] Falha ao buscar horários de {data_desejada}: {e}")
                todos_slots = []
            
            if periodo_desejado:
                todos_slots = [
                h for h in todos_slots if horario_esta_no_periodo(h["inicio"], periodo_desejado)
                ]

            if not todos_slots:
                resposta = f"😔 Não há horários disponíveis em {data_desejada}. "
                estado_por_usuario[numero_telefone] = "AGUARDANDO_DATA_MANUAL"
                return {"response": resposta, "audio_path": None, "slots": []}

            # Se só houver um slot nessa data:
            if len(todos_slots) == 1:
                h_obj = todos_slots[0]
                inicio_iso = h_obj["inicio"]  # ex: "2025-06-10T14:00:00-03:00"
                partes = inicio_iso.split("T")
                data_parte = partes[0]
                hora_parte = partes[1][:5]
                dia, mes = data_parte.split("-")[2], data_parte.split("-")[1]
                localTempo = tempo(int(dia), int(mes))
                friendly = f"{localTempo} às {hora_parte}"

                resposta = (
                    f"📅 Tenho o horário {friendly} disponível em {data_desejada} 😊 "
                    "Esse horário serve para você?"
                )
                cache_horarios_por_usuario[numero_telefone] = [
                    {"id": h_obj["id"], "inicio": h_obj["inicio"]}
                ]
                estado_por_usuario[numero_telefone] = "AGUARDANDO_CONFIRMACAO_UNICO_HORARIO"
                return {"response": resposta, "audio_path": None, "slots": []}

            # Se houver mais de um slot nessa data:
            friendly_list = []
            for h_obj in todos_slots[:6]:
                inicio_iso = h_obj["inicio"]
                partes = inicio_iso.split("T")
                data_parte = partes[0]
                hora_parte = partes[1][:5]
                dia, mes = data_parte.split("-")[2], data_parte.split("-")[1]
                friendly_list.append(f"{dia}/{mes} às {hora_parte}")

            if len(friendly_list) == 2:
                frase_horarios = f"{friendly_list[0]} e {friendly_list[1]}"
            else:
                frase_horarios = ", ".join(friendly_list[:-1]) + f" e {friendly_list[-1]}"

            resposta = (
                f"📅 Eu tenho os horários {frase_horarios} disponíveis em {data_desejada} 😊\n"
                "Qual deles funciona melhor para você?"
            )
            cache_lista = [{"id": h["id"], "inicio": h["inicio"]} for h in todos_slots[:6]]
            cache_horarios_por_usuario[numero_telefone] = cache_lista
            estado_por_usuario[numero_telefone] = "AGUARDANDO_ESCOLHA_HORARIO_HUMANO"
            return {"response": resposta, "audio_path": None, "slots": []}



        # 2) Se não houver data explícita, usamos um breve prompt ao LLM para decidir “sim/nao/outro”
        #    (por exemplo: “ele quer ver horários de amanhã?”, “ele quer cancelar?”, etc.)
        prompt_classificacao = (
            "Você é um classificador de intenção. Dada esta frase:\n\n"
            f"\"{texto}\"\n\n"
            "Responda somente uma das opções:\n"
            "- CONFIRMA_AMANHA  (quando quer ver horários de amanhã)\n"
            "- NEGA            (quando não aceita horário de amanhã)\n"
            "- OUTRA           (quando o usuário informa outra coisa diferente de sim ou não, "
            "por exemplo: pergunta, agradecimento, etc.)\n\n"
            "Classificação:"
        )
        llm_class = ChatOpenAI(temperature=0.0, model="gpt-4.1-nano", openai_api_key=openai_key)
        intent_resp = llm_class([HumanMessage(content=prompt_classificacao)]).content.strip().upper()

        if intent_resp == "CONFIRMA_AMANHA":
            # Mesmo comportamento de “sim” antigo: tentar buscar horários de amanhã
            hoje_str = get_current_date_brasilia()
            tomorrow_date_obj = datetime.strptime(hoje_str, "%Y-%m-%d") + timedelta(days=1)
            tomorrow_str = tomorrow_date_obj.strftime("%Y-%m-%d")

            try:
                resp_api_data = requests.get(
                    f"http://localhost:3001/api/horarios-disponiveis?date={tomorrow_str}",
                    headers={"Authorization": f"Bearer {token_jwt}"}, timeout=5
                )
                todos_slots = resp_api_data.status_code == 200 and resp_api_data.json().get("horarios", []) or []
            except Exception as e:
                print(f"[ERROR] Falha ao buscar horários de {tomorrow_str}: {e}")
                todos_slots = []

            if len(todos_slots) == 0:
                resposta = "😔 Também não há horários disponíveis para amanhã. Prefere tentar outra data? (YYYY-MM-DD)"
                estado_por_usuario[numero_telefone] = "AGUARDANDO_DATA_MANUAL"
                return {"response": resposta, "audio_path": None, "slots": []}

            if len(todos_slots) == 1:
                h_obj = todos_slots[0]
                inicio_iso = h_obj["inicio"]
                partes = inicio_iso.split("T")
                data_parte = partes[0]
                hora_parte = partes[1][:5]
                dia, mes = data_parte.split("-")[2], data_parte.split("-")[1]
                friendly = f"{dia}/{mes} às {hora_parte}"

                resposta = (
                    f"📅 Tenho o horário {friendly} disponível para amanhã 😊 "
                    "Esse horário serve para você?"
                )
                cache_horarios_por_usuario[numero_telefone] = [
                    {"id": h_obj["id"], "inicio": h_obj["inicio"]}
                ]
                estado_por_usuario[numero_telefone] = "AGUARDANDO_CONFIRMACAO_UNICO_HORARIO"
                return {"response": resposta, "audio_path": None, "slots": []}

            friendly_list = []
            for h_obj in todos_slots[:6]:
                inicio_iso = h_obj["inicio"]
                partes = inicio_iso.split("T")
                data_parte = partes[0]
                hora_parte = partes[1][:5]
                dia, mes = data_parte.split("-")[2], data_parte.split("-")[1]
                localTempo = tempo(int(dia), int(mes))
                friendly_list.append(f"{localTempo} às {hora_parte}")

            if len(friendly_list) == 2:
                frase_horarios = f"{friendly_list[0]} e {friendly_list[1]}"
            else:
                frase_horarios = ", ".join(friendly_list[:-1]) + f" e {friendly_list[-1]}"

            resposta = f"📅 Estes são os horários disponíveis para amanhã: {frase_horarios} 😊\nQual deles funciona melhor para você?"
            cache_lista = [{"id": h["id"], "inicio": h["inicio"]} for h in todos_slots[:6]]
            cache_horarios_por_usuario[numero_telefone] = cache_lista
            estado_por_usuario[numero_telefone] = "AGUARDANDO_ESCOLHA_HORARIO_HUMANO"
            return {"response": resposta, "audio_path": None, "slots": []}

        if intent_resp == "NEGA":
            # Mesmo comportamento de “não” antigo
            resposta = "👍 Sem problemas! Me diga a melhor Data para você, ou responda “AGENDAR” para ver opções de novo."
            estado_por_usuario[numero_telefone] = "AGUARDANDO_DATA_MANUAL"
            return {"response": resposta, "audio_path": None, "slots": []}

        # Se cair em OUTRA, significa que não é “sim” nem “não” nem data; então pedimos para reformular:
        resposta = "🤔 Desculpe, não entendi. Responda “sim” para ver horários de amanhã, “não” para tentar outra data, ou informe uma data."
        return {"response": resposta, "audio_path": None, "slots": []}





    # ─── Estado “AGUARDANDO_ESCOLHA_HORARIO_HUMANO” ─────────────────────────────────


    if estado_atual == AGUARDANDO_DATA_MANUAL:
        texto = user_message.strip()

        # Tenta extrair data completa ou apenas dia/mês + período do dia
        info_extracao = extract_date_e_periodo(user_message, openai_key)
        data_desejada = info_extracao["date"] if info_extracao else None
        periodo_desejado = info_extracao["periodo"] if info_extracao else None

        if not data_desejada:
            return {
                "response": "❌ Não consegui entender a data. Por favor, envie no formato “DD/MM” ou “9 de junho”.",
                "audio_path": None,
                "slots": []
            }

        try:
            resp = requests.get(
                f"http://localhost:3001/api/horarios-disponiveis?date={data_desejada}",
                headers={"Authorization": f"Bearer {token_jwt}"}, timeout=5
            )
            todos_slots = resp.status_code == 200 and resp.json().get("horarios", []) or []
        except Exception as e:
            print(f"[ERROR] Falha ao buscar horários de {data_desejada}: {e}")
            todos_slots = []

        if not todos_slots:
            estado_por_usuario[numero_telefone] = AGUARDANDO_DATA_MANUAL
            return {
                "response": f"😔 Não há horários disponíveis em {data_desejada}. Tente outra data (ex: “10/06”).",
                "audio_path": None,
                "slots": []
            }

        # Filtra horários futuros se a data for hoje
        hoje_str = get_current_date_brasilia()
        hoje_utc = get_current_datetime_aware_utc()

        if data_desejada == hoje_str:
            todos_slots = [
                h for h in todos_slots
                if datetime.fromisoformat(h["inicio"]).astimezone(timezone.utc) > hoje_utc
            ]

        # ➕ aplica filtro pelo período mencionado, se houver (ex: só “de manhã”)
        if periodo_desejado:
            todos_slots = [h for h in todos_slots if horario_esta_no_periodo(h["inicio"], periodo_desejado)]

        slots_para_exibir = todos_slots[:6]

        if not slots_para_exibir:
            estado_por_usuario[numero_telefone] = AGUARDANDO_DATA_MANUAL
            return {
                "response": f"😔 Não há horários disponíveis em {data_desejada} no período informado.",
                "audio_path": None,
                "slots": []
            }

        # 1 horário
        if len(slots_para_exibir) == 1:
            h = slots_para_exibir[0]
            dia, mes = h["inicio"].split("T")[0].split("-")[2:]
            hora = h["inicio"].split("T")[1][:5]
            localTempo = tempo(int(dia), int(mes))
            friendly = f"{localTempo} às {hora}"
            texto_resposta = f"📅 Tenho só o horário {friendly} disponível 😊 Esse horário serve para você?"
            cache_horarios_por_usuario[numero_telefone] = [{"id": h["id"], "inicio": h["inicio"]}]
            estado_por_usuario[numero_telefone] = "AGUARDANDO_CONFIRMACAO_UNICO_HORARIO"
            return {"response": texto_resposta, "audio_path": None, "slots": []}

        # Vários horários
        friendly_list = []
        for h in slots_para_exibir:
            dia, mes = h["inicio"].split("T")[0].split("-")[2:]
            hora = h["inicio"].split("T")[1][:5]
            friendly_list.append(f"{dia}/{mes} às {hora}")

        if len(friendly_list) == 2:
            frase = f"{friendly_list[0]} e {friendly_list[1]}"
        else:
            frase = ", ".join(friendly_list[:-1]) + f" e {friendly_list[-1]}"

        texto_resposta = f"📅 Eu tenho os horários {frase} disponíveis em {data_desejada} 😊\nQual deles funciona melhor para você?"
        cache_horarios_por_usuario[numero_telefone] = [
            {"id": h["id"], "inicio": h["inicio"]} for h in slots_para_exibir
        ]
        estado_por_usuario[numero_telefone] = "AGUARDANDO_ESCOLHA_HORARIO_HUMANO"
        return {"response": texto_resposta, "audio_path": None, "slots": []}

    if estado_atual == "AGUARDANDO_ESCOLHA_HORARIO_HUMANO":
        recebido = user_message.strip()
        slots_cache: List[Dict[str, str]] = cache_horarios_por_usuario.get(numero_telefone, [])

        escolhido_idx = escolher_slot_com_llm(recebido, slots_cache, openai_key)

        if escolhido_idx is not None:
            slot_escolhido = slots_cache[escolhido_idx]
            event_id = slot_escolhido["id"]
            inicio_iso = slot_escolhido["inicio"]  # ex: "2025-06-06T10:00:00-03:00"
            partes = inicio_iso.split("T")
            data_parte, hora_parte = partes[0], partes[1][:5]
            dt_iso = f"{data_parte}T{hora_parte}:00-03:00"
            data_evento = datetime.fromisoformat(dt_iso)
            data_fim = data_evento + timedelta(minutes=60)

            cliente_nome = get_name_from_db(numero_telefone, token_jwt) or "Cliente"
            payload_edit = {
                "id":      event_id,
                "summary": f"Atendimento {cliente_nome}",
                "start":   {"dateTime": data_evento.isoformat()},
                "end":     {"dateTime": data_fim.isoformat()},
                "colorId": "10"
            }
            resp = requests.put(
                "http://localhost:3001/api/google/editar-evento",
                json=payload_edit,
                headers={"Authorization": f"Bearer {token_jwt}"}
            )

            if resp.status_code == 200:
                dia, mes = data_parte.split("-")[2], data_parte.split("-")[1]
                texto = f"✅ Pronto, {cliente_nome}! Seu atendimento está marcado para {dia}/{mes} às {hora_parte} 😊"

                # Em vez de chamar gerar-cobranca, checamos se já temos um customerId
                if numero_telefone not in customerId_por_usuario:
                    # Se ainda não temos customerId, iniciamos coleta de dados do Asaas
                    estado_por_usuario[numero_telefone] = COLETANDO_NOME
                    return {
                        "response": texto + "\n\nPara emitir o boleto, preciso cadastrar você no Asaas. Qual é o seu nome completo?",
                        "audio_path": None,
                        "slots": []
                    }
                else:
                    # Já temos customerId: geramos a cobrança de uma vez
                    asaasToken = get_user_config(token_jwt).get("asaasKey")
                    link = gerar_cobranca_asaas_sandbox(
                        customerId_por_usuario[numero_telefone], 300.0, asaasToken
                    )
                    if link:
                        texto += f" Aqui está seu link de pagamento 💳: {link}"
                    else:
                        texto += " Mas não consegui gerar o boleto. 😕"

            cache_horarios_por_usuario.pop(numero_telefone, None)
            estado_por_usuario[numero_telefone] = "INICIAL"
            caminho_audio = None if contains_date_or_time(texto) else gerar_audio(texto, f"{numero_telefone}.mp3")
            return {"response": texto, "audio_path": caminho_audio, "slots": []}

        texto = (
            "🤔 Não consegui identificar qual horário você escolheu. "
            "Por favor, digite algo como “1” ou “o segundo horário”."
        )
        return {"response": texto, "audio_path": None, "slots": []}


    # ─── Estado “AGUARDANDO_CONFIRMACAO_UNICO_HORARIO” ─────────────────────────────
    if estado_atual == "AGUARDANDO_CONFIRMACAO_UNICO_HORARIO":
        texto_recebido = user_message.strip().lower()

        if any(p in texto_recebido for p in ["sim", "pode", "beleza", "ok", "claro"]):
            slot_dict = cache_horarios_por_usuario.get(numero_telefone, [None])[0]
            if slot_dict:
                # extraímos data e hora de slot_dict["inicio"]
                inicio_iso = slot_dict["inicio"]  # ex: "2025-06-06T10:00:00-03:00"
                partes = inicio_iso.split("T")
                data_parte = partes[0]             # "2025-06-06"
                hora_parte = partes[1][:5]         # "10:00"
                dt_iso = f"{data_parte}T{hora_parte}:00-03:00"
                data_evento = datetime.fromisoformat(dt_iso)
                data_fim = data_evento + timedelta(minutes=60)

                event_id = slot_dict["id"]

                cliente_nome = get_name_from_db(numero_telefone, token_jwt) or "Cliente"
                payload_evento = {
                    "id":      event_id,
                    "summary": f"Atendimento {cliente_nome}",
                    "start":   {"dateTime": data_evento.isoformat()},
                    "end":     {"dateTime": data_fim.isoformat()},
                    "colorId": "10"
                }
                resp_create = requests.put(
                    "http://localhost:3001/api/google/editar-evento",
                    json=payload_evento,
                    headers={"Authorization": f"Bearer {token_jwt}"}
                )
                print("resp_create: ", resp_create)
                if resp_create.status_code == 200:
                    try:
                        dia, mes = data_parte.split("-")[2], data_parte.split("-")[1]
                        texto = f"✅ Pronto, {cliente_nome}! Seu atendimento está marcado para {dia}/{mes} às {hora_parte} 😊"

                        # Em vez de chamar gerar-cobranca, checamos se já temos um customerId
                        if numero_telefone not in customerId_por_usuario:
                            # Se ainda não temos customerId, iniciamos coleta de dados do Asaas
                            estado_por_usuario[numero_telefone] = COLETANDO_NOME
                            return {
                                "response": texto + "\n\nPara emitir o boleto, preciso cadastrar você no Asaas. Qual é o seu nome completo?",
                                "audio_path": None,
                                "slots": []
                            }
                        else:
                            # Já temos customerId: geramos a cobrança de uma vez
                            asaasToken = get_user_config(token_jwt).get("asaasKey")
                            link = gerar_cobranca_asaas_sandbox(
                                customerId_por_usuario[numero_telefone], 300.0, asaasToken
                            )
                            if link:
                                texto += f" Aqui está seu link de pagamento 💳: {link}"
                            else:
                                texto += " Mas não consegui gerar o boleto. 😕"

                    except Exception as e:
                        print(f"[ERROR] Falha ao gerar cobrança ASAAS: {e}")
                        texto += " Mas houve um erro ao gerar o boleto. 😕"
                else:
                    texto = "😔 Ops, não consegui criar o compromisso. Por favor, tente novamente mais tarde."

                cache_horarios_por_usuario.pop(numero_telefone, None)
                estado_por_usuario[numero_telefone] = "INICIAL"
                caminho_audio = None if contains_date_or_time(texto) else gerar_audio(texto, f"{numero_telefone}.mp3")
                return {"response": texto, "audio_path": caminho_audio, "slots": []}

            texto = "😕 Desculpe, houve um erro interno. Pode tentar novamente pedir para agendar?"
            estado_por_usuario[numero_telefone] = "INICIAL"
            return {"response": texto, "audio_path": None, "slots": []}

        if any(p in texto_recebido for p in ["não", "nao", "nops", "não serve"]):
            texto = "👍 Sem problemas! Me diga a Melhor Data para você!"
            cache_horarios_por_usuario.pop(numero_telefone, None)
            estado_por_usuario[numero_telefone] = "AGUARDANDO_ESCOLHA_HORARIO_FUTURO"
            return {"response": texto, "audio_path": None, "slots": []}


        if estado_atual in {
            AGUARDANDO_CONFIRMACAO_UNICO_HORARIO,
            AGUARDANDO_ESCOLHA_HORARIO_HUMANO,
            AGUARDANDO_CONFIRMACAO_AMANHA
        }:
            # Tentar detectar se ele está pedindo outra data
            nova_data_iso = detectar_troca_data(user_message, openai_key)
            if nova_data_iso:
                # 1) Busca 40% dos horários disponíveis para essa nova_data_iso
                slots_para_futuro, texto = obter_e_formatar_horarios_futuros(
                    nova_data_iso, token_jwt, openai_key
                )

                if not slots_para_futuro:
                    # A própria função já formata uma mensagem no caso de “vazio” ou “erro”
                    return {"response": texto, "audio_path": None, "slots": []}

                # 2) Guarda no cache para quando o usuário escolher
                #    Transformamos cada slot em {"id":..., "inicio":...} (igual a outros lugares)
                cache_horarios_por_usuario[numero_telefone] = [
                    {"id": h["id"], "inicio": h["inicio"]} for h in slots_para_futuro
                ]

                # 3) Seta o novo estado para esperar a escolha
                estado_por_usuario[numero_telefone] = AGUARDANDO_ESCOLHA_HORARIO_FUTURO

                # 4) Retorna a lista parcial formatada
                return {"response": texto, "audio_path": None, "slots": []}
        

        texto = "🤔 Desculpe, não entendi. Responda “sim” se esse horário serve ou “não” para escolher outro."
        return {"response": texto, "audio_path": None, "slots": []}

    # ─── Se chegar aqui, não estamos em nenhum estado de confirmação de horário ─────
    try:
        intent = detect_intent_llm(user_message, openai_key)
    except Exception as e:
        intent = "OUTRO"
        print(f"[ERROR] Falha ao detectar intenção: {e}")


    # ─── 4) Intenção AGENDAR (início do fluxo “INICIAL”) ─────────────────────────
    if intent == "AGENDAR":
        info = analyze_user_for_scheduling(user_message, openai_key)
        hoje_str = get_current_date_brasilia()
        hoje_utc = get_current_datetime_aware_utc()
        # 1) Se faltou data, inferir
        if info["date"] is None:
            info_extracao = extract_date_e_periodo(user_message, openai_key)
            data_desejada = info_extracao["date"] if info_extracao else None
            periodo_desejado = info_extracao["periodo"] if info_extracao else None

            if periodo_desejado:
                todos_horarios_req = [h for h in todos_horarios_req if horario_esta_no_periodo(h["inicio"], periodo_desejado)]


            # buscar os horários da data inferida
            resp = requests.get(
                f"http://localhost:3001/api/horarios-disponiveis?date={data_desejada}",
                headers={"Authorization": f"Bearer {token_jwt}"}, timeout=5
            )
            todos_slots = resp.json().get("horarios", [])
        

            # ➕ aplica filtro pelo período mencionado, se houver
            if periodo_desejado:
                todos_slots = [h for h in todos_slots if horario_esta_no_periodo(h["inicio"], periodo_desejado)]

            if data_desejada:
                info["date"] = data_desejada
                info["needs_slots"] = True

        # 2) Se agora temos uma data (qualquer: veio de extract_datetime ou foi inferida),
        #    buscar horários nessa data
        if info["date"]:
            data_solicitada = info["date"]
            try:
                resp = requests.get(
                    f"http://localhost:3001/api/horarios-disponiveis?date={data_solicitada}",
                    headers={"Authorization": f"Bearer {token_jwt}"}, timeout=5
                )
                todos_slots = resp.status_code == 200 and resp.json().get("horarios", []) or []
            except:
                todos_slots = []

            # filtrar futuros se for hoje
            if data_solicitada == hoje_str:
                futuros = []
                for h in todos_slots:
                    try:
                        dt_slot = datetime.fromisoformat(h["inicio"])
                        if dt_slot.astimezone(timezone.utc) > hoje_utc:
                            futuros.append(h)
                    except:
                        continue
                slots_para_exibir = futuros[:6]
            else:
                slots_para_exibir = todos_slots[:6]

            # 2.1) se só 1 horário
            if len(slots_para_exibir) == 1:
                h = slots_para_exibir[0]
                dia, mes = h["inicio"].split("T")[0].split("-")[2:]
                hora = h["inicio"].split("T")[1][:5]
                localTempo = tempo(int(dia), int(mes))
                friendly = f"{localTempo} às {hora}"
                texto = f"📅 Tenho só o horário {friendly} disponível 😊 Esse horário serve para você?"
                cache_horarios_por_usuario[numero_telefone] = [{"id": h["id"], "inicio": h["inicio"]}]
                estado_por_usuario[numero_telefone] = "AGUARDANDO_CONFIRMACAO_UNICO_HORARIO"
                return {"response": texto, "audio_path": None, "slots": []}

            # 2.2) se vários horários
            if len(slots_para_exibir) > 1:
                friendly_list = []
                for h in slots_para_exibir:
                    dia, mes = h["inicio"].split("T")[0].split("-")[2:]
                    hora = h["inicio"].split("T")[1][:5]
                    friendly_list.append(f"{dia}/{mes} às {hora}")
                frase = (
                    f"{friendly_list[0]} e {friendly_list[1]}"
                    if len(friendly_list) == 2
                    else ", ".join(friendly_list[:-1]) + f" e {friendly_list[-1]}"
                )
                texto = f"📅 Eu tenho os horários {frase} disponíveis 😊\nQual deles funciona melhor para você?"
                cache_horarios_por_usuario[numero_telefone] = [
                    {"id": h["id"], "inicio": h["inicio"]}
                    for h in slots_para_exibir
                ]
                estado_por_usuario[numero_telefone] = "AGUARDANDO_ESCOLHA_HORARIO_HUMANO"
                return {"response": texto, "audio_path": None, "slots": []}

            # 2.3) se nenhum horário
            texto = f"😔 Não há horários disponíveis em {data_solicitada}. Digite outra data."
            cache_horarios_por_usuario[numero_telefone] = []
            estado_por_usuario[numero_telefone] = "AGUARDANDO_DATA_MANUAL"
            return {"response": texto, "audio_path": None, "slots": []}

        tomorrow_date_obj = datetime.strptime(hoje_str, "%Y-%m-%d") + timedelta(days=1)
        tomorrow_str = tomorrow_date_obj.strftime("%Y-%m-%d")

        # 4.4) Se ainda não temos data (info["date"] é None), buscar HOJE → AMANHÃ → DEPOIS DE AMANHÃ
        if info["needs_slots"] and info.get("date") is None:
            try:
                resp_api = requests.get(
                    f"http://localhost:3001/api/horarios-disponiveis?date={hoje_str}",
                    headers={"Authorization": f"Bearer {token_jwt}"}, timeout=5
                )
                if resp_api.status_code == 200:
                    todos_horarios = resp_api.json().get("horarios", [])
                else:
                    todos_horarios = []
            except Exception as e:
                print(f"[ERROR] Falha ao buscar horários de hoje: {e}")
                todos_horarios = []

            futuros = []
            now_utc = get_current_datetime_aware_utc()
            for h_obj in todos_horarios:
                inicio_iso = h_obj.get("inicio")
                try:
                    dt_slot = datetime.fromisoformat(inicio_iso)
                except:
                    continue
                dt_slot_utc = dt_slot.astimezone(timezone.utc)
                diferenca = dt_slot_utc - now_utc
                # só aceita horários pelo menos 1 hora à frente
                if diferenca > timedelta(hours=1):
                    futuros.append(h_obj)

            opcoes_hoje = futuros[:6]
            # Se só houver 1 opção hoje, perguntar:
            if len(opcoes_hoje) == 1:
                h_obj = opcoes_hoje[0]
                inicio_iso = h_obj.get("inicio")
                partes = inicio_iso.split("T")
                data_parte = partes[0]
                hora_parte = partes[1][:5]
                dia, mes = data_parte.split("-")[2], data_parte.split("-")[1]
                friendly = f"{dia}/{mes} às {hora_parte}"

                texto = (
                    f"📅 Tenho só o horário {friendly} disponível 😊 "
                    "Esse horário serve para você?"
                )
                cache_horarios_por_usuario[numero_telefone] = [
    {"id": h_obj["id"], "inicio": h_obj["inicio"]}
]
                estado_por_usuario[numero_telefone] = "AGUARDANDO_CONFIRMACAO_UNICO_HORARIO"
                return {"response": texto, "audio_path": None, "slots": []}

            # Se houver múltiplas opções hoje, exibir humano:
            print("opcoes_hoje: ", opcoes_hoje)
            if opcoes_hoje:
                friendly_list = []
                for h_obj in opcoes_hoje:
                    inicio_iso = h_obj.get("inicio")
                    partes = inicio_iso.split("T")
                    data_parte = partes[0]
                    hora_parte = partes[1][:5]
                    dia, mes = data_parte.split("-")[2], data_parte.split("-")[1]
                    friendly_list.append(f"{dia}/{mes} às {hora_parte}")

                if len(friendly_list) == 2:
                    frase_horarios = f"{friendly_list[0]} e {friendly_list[1]}"
                else:
                    frase_horarios = ", ".join(friendly_list[:-1]) + f" e {friendly_list[-1]}"

                texto = (
                    f"📅 Tenho os horários {frase_horarios} disponíveis hoje 😊\n"
                    "Qual deles funciona melhor para você?"
                )
                cache_lista = [
                    {"id": h["id"], "inicio": h["inicio"]}
                    for h in opcoes_hoje
                ]
                cache_horarios_por_usuario[numero_telefone] = cache_lista

                estado_por_usuario[numero_telefone] = "AGUARDANDO_ESCOLHA_HORARIO_HUMANO"
                return {"response": texto, "audio_path": None, "slots": []}
            else:
                # 4.4.2) Se não há horários hoje, buscar AMANHÃ
                try:
                    resp_api2 = requests.get(
                        f"http://localhost:3001/api/horarios-disponiveis?date={tomorrow_str}",
                        headers={"Authorization": f"Bearer {token_jwt}"}, timeout=5
                    )
                    if resp_api2.status_code == 200:
                        todos_horarios_amanha = resp_api2.json().get("horarios", [])
                    else:
                        todos_horarios_amanha = []
                except Exception as e:
                    print(f"[ERROR] Falha ao buscar horários de amanhã: {e}")
                    todos_horarios_amanha = []

                opcoes_amanha = todos_horarios_amanha[:6]
                # Se apenas 1 opção amanhã, perguntar:
                if len(opcoes_amanha) == 1:
                    h_obj = opcoes_amanha[0]
                    inicio_iso = h_obj.get("inicio")
                    partes = inicio_iso.split("T")
                    data_parte = partes[0]
                    hora_parte = partes[1][:5]
                    dia, mes = data_parte.split("-")[2], data_parte.split("-")[1]
                    localTempo = tempo(int(dia), int(mes))
                    friendly = f"{localTempo} às {hora_parte}"

                    texto = (
                        f"📅 Tenho só o horário {friendly} disponível para amanhã 😊 "
                        "Esse horário serve para você?"
                    )
                    cache_horarios_por_usuario[numero_telefone] = [
    {"id": h_obj["id"], "inicio": h_obj["inicio"]}
]

                    estado_por_usuario[numero_telefone] = "AGUARDANDO_CONFIRMACAO_UNICO_HORARIO"
                    return {"response": texto, "audio_path": None, "slots": []}

                # Se houver múltiplas opções amanhã, exibir humano:
                if opcoes_amanha:
                    friendly_list = []
                    for h_obj in opcoes_amanha:
                        inicio_iso = h_obj.get("inicio")
                        partes = inicio_iso.split("T")
                        data_parte = partes[0]
                        hora_parte = partes[1][:5]
                        dia, mes = data_parte.split("-")[2], data_parte.split("-")[1]
                        friendly_list.append(f"{dia}/{mes} às {hora_parte}")

                    if len(friendly_list) == 2:
                        frase_horarios = f"{friendly_list[0]} e {friendly_list[1]}"
                    else:
                        frase_horarios = ", ".join(friendly_list[:-1]) + f" e {friendly_list[-1]}"

                    texto = (
                        f"📅 Hoje está tudo preenchido. Estes são os horários para amanhã: {frase_horarios} 😊\n"
                        "Qual deles funciona melhor para você?"
                    )
                    cache_lista = [
                        {"id": h["id"], "inicio": h["inicio"]}
                        for h in opcoes_amanha
                    ]
                    cache_horarios_por_usuario[numero_telefone] = cache_lista

                    estado_por_usuario[numero_telefone] = "AGUARDANDO_ESCOLHA_HORARIO_HUMANO"
                    return {"response": texto, "audio_path": None, "slots": []}

                # 4.4.3) Se nem amanhã tiver slots, buscar depois de amanhã
                day_after_date = (tomorrow_date_obj + timedelta(days=1)).strftime("%Y-%m-%d")
                try:
                    resp_api3 = requests.get(
                        f"http://localhost:3001/api/horarios-disponiveis?date={day_after_date}",
                        headers={"Authorization": f"Bearer {token_jwt}"}, timeout=5
                    )
                    print("response: ", resp_api3)
                    if resp_api3.status_code == 200:
                        todos_horarios_dia_seguinte = resp_api3.json().get("horarios", [])
                    else:
                        todos_horarios_dia_seguinte = []
                except Exception as e:
                    print(f"[ERROR] Falha ao buscar horários de depois de amanhã: {e}")
                    todos_horarios_dia_seguinte = []

                opcoes_dia_seguinte = todos_horarios_dia_seguinte[:6]
                # Se só 1 opção pós amanhã, perguntar:
                if len(opcoes_dia_seguinte) == 1:
                    h_obj = opcoes_dia_seguinte[0]
                    inicio_iso = h_obj.get("inicio")
                    partes = inicio_iso.split("T")
                    data_parte = partes[0]
                    hora_parte = partes[1][:5]
                    dia, mes = data_parte.split("-")[2], data_parte.split("-")[1]
                    friendly = f"{dia}/{mes} às {hora_parte}"

                    texto = (
                        f"📅 Não há horários hoje nem amanhã. Tenho só o horário {friendly} para depois de amanhã 😊 "
                        "Esse horário serve para você? (responda “sim” ou “não”)"
                    )
                    cache_horarios_por_usuario[numero_telefone] = [
    {"id": h_obj["id"], "inicio": h_obj["inicio"]}
]

                    estado_por_usuario[numero_telefone] = "AGUARDANDO_CONFIRMACAO_UNICO_HORARIO"
                    return {"response": texto, "audio_path": None, "slots": []}

                # Se múltiplas opções para depois de amanhã, exibir humano:
                if opcoes_dia_seguinte:
                    friendly_list = []
                    for h_obj in opcoes_dia_seguinte:
                        inicio_iso = h_obj.get("inicio")
                        partes = inicio_iso.split("T")
                        data_parte = partes[0]
                        hora_parte = partes[1][:5]
                        dia, mes = data_parte.split("-")[2], data_parte.split("-")[1]
                        friendly_list.append(f"{dia}/{mes} às {hora_parte}")

                    if len(friendly_list) == 2:
                        frase_horarios = f"{friendly_list[0]} e {friendly_list[1]}"
                    else:
                        frase_horarios = ", ".join(friendly_list[:-1]) + f" e {friendly_list[-1]}"

                    texto = (
                        f"📅 Não há horários hoje nem amanhã. Estes são os horários para depois de amanhã: {frase_horarios} 😊\n"
                        "Qual deles funciona melhor para você?"
                    )
                    lista_cache3 = [
                        {"id": h["id"], "inicio": h["inicio"]}
                        for h in opcoes_dia_seguinte
                    ]
                    cache_horarios_por_usuario[numero_telefone] = lista_cache3
                    estado_por_usuario[numero_telefone] = "AGUARDANDO_ESCOLHA_HORARIO_HUMANO"
                    return {"response": texto, "audio_path": None, "slots": []}

                # 4.4.4) Se nem depois de amanhã tiver slots
                texto = "❓ Não há horários disponíveis nos próximos dias. Prefere outro dia ou período?"
                cache_horarios_por_usuario[numero_telefone] = []
                estado_por_usuario[numero_telefone] = "INICIAL"
                return {"response": texto, "audio_path": None, "slots": []}

                # Verificar
    elif intent == "VERIFICAR":
        texto = user_message.strip()
        info = extract_date_e_periodo(texto, openai_key)
        data_desejada = info["date"] if info else None
        periodo_desejado = info["periodo"] if info else None

        agora_utc = get_current_datetime_aware_utc()

        if data_desejada:
            try:
                resp_api = requests.get(
                    f"http://localhost:3001/api/horarios-disponiveis?date={data_desejada}",
                    headers={"Authorization": f"Bearer {token_jwt}"}, timeout=5
                )
                todos_horarios_req = (
                    resp_api.status_code == 200 and resp_api.json().get("horarios", []) or []
                )
            except Exception as e:
                print(f"[ERROR] Falha ao buscar horários para {data_desejada}: {e}")
                todos_horarios_req = []

            futuros_req = [
                h for h in todos_horarios_req
                if datetime.fromisoformat(h["inicio"]).astimezone(timezone.utc) > agora_utc
            ]

            if periodo_desejado:
                futuros_req = [
                    h for h in futuros_req if horario_esta_no_periodo(h["inicio"], periodo_desejado)
                ]

            selecionados = futuros_req[:3]

            if not selecionados:
                return {
                    "response": f"😔 Não há horários disponíveis em {data_desejada}.",
                    "audio_path": None,
                    "slots": []
                }

            friendly = [
                f"{h['inicio'].split('T')[0].split('-')[2]}/{h['inicio'].split('T')[0].split('-')[1]} às {h['inicio'].split('T')[1][:5]}"
                for h in selecionados
            ]

            if len(friendly) == 1:
                texto = f"👍 Só tenho {friendly[0]} nessa data. Esse horário serve?"
                estado_por_usuario[numero_telefone] = "AGUARDANDO_CONFIRMACAO_UNICO_HORARIO"
                cache_horarios_por_usuario[numero_telefone] = [{
                    "id": selecionados[0]["id"],
                    "inicio": selecionados[0]["inicio"]
                }]
            else:
                lista_amig = " ou ".join(friendly)
                texto = f"📅 Posso agendar em {lista_amig} naquela data. Qual funciona melhor?"
                estado_por_usuario[numero_telefone] = "AGUARDANDO_ESCOLHA_HORARIO_HUMANO"
                cache_horarios_por_usuario[numero_telefone] = [
                    {"id": h["id"], "inicio": h["inicio"]} for h in selecionados
                ]

            return {"response": texto, "audio_path": None, "slots": []}

        # Fluxo alternativo se não tiver `data_desejada`
        try:
            resp_api = requests.get(
                "http://localhost:3001/api/horarios-disponiveis",
                headers={"Authorization": f"Bearer {token_jwt}"}, timeout=5
            )
            todos_horarios_verificar = (
                resp_api.status_code == 200 and resp_api.json().get("horarios", []) or []
            )
        except Exception as e:
            print(f"[ERROR] Falha ao buscar horários em VERIFICAR: {e}")
            todos_horarios_verificar = []

        futuros_verificar = [
            h for h in todos_horarios_verificar
            if datetime.fromisoformat(h["inicio"]).astimezone(timezone.utc) > agora_utc
        ]

        selecionados = futuros_verificar[:3]

        if not selecionados:
            cliente_nome = get_name_from_db(numero_telefone, token_jwt) or "Cliente"
            estado_por_usuario[numero_telefone] = "AGUARDANDO_CONFIRMACAO_AMANHA"
            resposta_texto = gerar_resposta_natural(
                user_message=user_message,
                estado="SEM_HORARIOS_HOJE",
                cliente_nome=cliente_nome,
                data_desejada=None,
                horarios_friendly=None,
                openai_key=openai_key
            )
            return {"response": resposta_texto, "audio_path": None, "slots": []}

        friendly = []
        for h in selecionados:
            data_iso, hora_iso = h["inicio"].split("T")
            _, mes, dia = data_iso.split("-")
            hhmm = hora_iso[:5]
            friendly.append(f"{dia}/{mes} às {hhmm}")

        if len(friendly) == 1:
            texto = f"👍 Só tenho {friendly[0]}. Esse horário serve?"
            estado_por_usuario[numero_telefone] = "AGUARDANDO_CONFIRMACAO_UNICO_HORARIO"
            cache_horarios_por_usuario[numero_telefone] = [{
                    "id": selecionados[0]["id"],
                    "inicio": selecionados[0]["inicio"]
                }]
        else:
            lista_amig = " ou ".join(friendly)
            texto = f"📅 Posso agendar em {lista_amig}. Qual funciona melhor?"
            estado_por_usuario[numero_telefone] = "AGUARDANDO_ESCOLHA_HORARIO_HUMANO"
            cache_horarios_por_usuario[numero_telefone] = [
                {"id": h["id"], "inicio": h["inicio"]} for h in selecionados
            ]

        caminho_audio = None if contains_date_or_time(texto) else gerar_audio(texto, f"{numero_telefone}.mp3")
        return {"response": texto, "audio_path": caminho_audio, "slots": []}


    # ─── 6) Intenção REAGENDAR ───────────────────────────────────────────────────────
    elif intent == "REAGENDAR":
        texto = "✏️ Entendi que você quer remarcar. Me informe a nova data/horário 😊"
        
        caminho_audio = None if contains_date_or_time(texto) else gerar_audio(texto, f"{numero_telefone}.mp3")
        estado_por_usuario[numero_telefone] = "INICIAL" 
        return {"response": texto, "audio_path": caminho_audio, "slots": []}

    # ─── 7) Intenção CANCELAR ────────────────────────────────────────────────────────
    elif intent == "CANCELAR":
        texto = "🗑️ Tudo bem, vou cancelar seu compromisso. Tem algo mais que eu poderia ajudar?"
        caminho_audio = None if contains_date_or_time(texto) else gerar_audio(texto, f"{numero_telefone}.mp3")
        estado_por_usuario[numero_telefone] = "INICIAL"
        return {"response": texto, "audio_path": caminho_audio, "slots": []}

    # ─── 8) Intenção OUTRO (retrieval + memória) ───────────────────────────────────
    else:
        llm = get_llm(openai_key)
        historico_texto = ""
        for entry in memoria.chat_memory.messages:
            quem = getattr(entry, "sender", "cliente")
            texto_e = entry.content if hasattr(entry, "content") else ""
            historico_texto += f"[{quem}] {texto_e}\n"

        prompt_template = PromptTemplate(
            input_variables=["context", "chat_history", "question"],
            template=(
                f"{prompt_instrucoes}\n\n"
                "Histórico do chat (últimos trechos):\n"
                "{chat_history}\n\n"
                "Contexto relevante extraído (se houver):\n"
                "{context}\n\n"
                "A mensagem atual do cliente:\n"
                "{question}\n\n"
                "Responda de forma humana e natural 😊"
            )
        )

        qa_chain = ConversationalRetrievalChain.from_llm(
            llm=llm,
            retriever=db.as_retriever(),
            memory=memoria,
            combine_docs_chain_kwargs={
                "prompt": prompt_template,
                "document_variable_name": "context"
            }
        )
        try:
            resposta_texto = qa_chain.invoke({"question": user_message})["answer"]
        except Exception as e:
            print(f"[⚠️] Erro interno no LLM: {e}")
            resposta_texto = "😔 Tive um problema ao processar sua mensagem. Pode tentar novamente?"

        if not resposta_texto:
            resposta_texto = "Desculpe, não consegui entender sua solicitação. 😕"

        estado_por_usuario[numero_telefone] = "INICIAL"
        ext = extract_name_and_phone_llm(user_message, openai_key)
        save_memory_to_db(
            numero=numero_telefone,       # ← quem enviou a mensagem
            who="user",                   # ← tipo de remetente
            text=user_message,           # ← conteúdo da mensagem
            token_jwt=token_jwt,
            name=ext.get("name"),
            phone=ext.get("phone")
        )
        save_memory_to_db(
            numero=numero_telefone,       # ← quem enviou a mensagem
            who="bot",                   # ← tipo de remetente
            text=resposta_texto,           # ← conteúdo da mensagem
            token_jwt=token_jwt,
            name=ext.get("name"),
            phone=ext.get("phone")
        )



        caminho_audio = None if contains_date_or_time(resposta_texto) else gerar_audio(resposta_texto, f"{numero_telefone}.mp3")
        return {"response": resposta_texto, "audio_path": caminho_audio, "slots": []}


# ─── 12) FastAPI app e endpoint /generate ───────────────────────────────────────
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

# ─── CORS para permitir chamadas do React em http://localhost:3000 ─────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],  # ajuste para a URL do seu React
    allow_credentials=True,
    allow_methods=["*"],      # permite GET, POST, PUT, DELETE, OPTIONS...
    allow_headers=["*"],      # permite todos os headers (incluindo Authorization)
)

class MessageRequest(BaseModel):
    sender: str
    message: str
    numeroConectado: str

class QuestionRequest(BaseModel):
    question: str

def obter_lista_eventos_do_google(token_jwt: str) -> List[dict]:
    """
    Chama seu endpoint interno que lista todos os eventos do usuário no Google Calendar.
    Deve retornar a lista de objetos { id, summary, start:{"dateTime":...}, end:{"dateTime":...}, ... }.
    """
    try:
        resp = requests.get(
            "http://localhost:3001/api/google/listar-eventos",
            headers={"Authorization": f"Bearer {token_jwt}"},
            timeout=10
        )
        if resp.status_code == 200:
            return resp.json().get("eventos", [])
    except Exception:
        pass
    return []

@app.post("/api/question")
async def question_handler(
    req: QuestionRequest,
    authorization: str = Header(None)
):
    if not authorization:
        raise HTTPException(status_code=401, detail="Token JWT ausente no header Authorization")
    token_jwt = authorization.replace("Bearer ", "")

    pergunta = req.question.strip()
    openai_key = get_user_config(token_jwt).get("openaiKey") or os.environ.get("OPENAI_API_KEY")

    texto_lower = pergunta.lower()
    agora_utc = get_current_datetime_aware_utc()

    # ─── Caso “próximo agendamento” (texto contenha “próximo” e “agendamento”)
    if "próximo agendamento" in texto_lower or "próximo compromisso" in texto_lower:
        todos_eventos = obter_lista_eventos_do_google(token_jwt)
        futuros = []
        for ev in todos_eventos:
            dt_inicio_str = ev.get("start", {}).get("dateTime")
            if not dt_inicio_str:
                continue
            try:
                dt_obj = datetime.fromisoformat(dt_inicio_str)
            except:
                continue
            dt_utc = dt_obj.astimezone(timezone.utc)
            if dt_utc > agora_utc:
                futuros.append((dt_utc, ev))

        if not futuros:
            return {"answer": "❌ Não há agendamentos futuros."}

        futuros.sort(key=lambda x: x[0])
        evento_prox = futuros[0][1]
        summary = evento_prox.get("summary", "(Sem título)")
        dt_str = evento_prox.get("start", {}).get("dateTime")
        try:
            dt_obj_local = datetime.fromisoformat(dt_str)
            formatted = dt_obj_local.strftime("%d/%m/%Y %H:%M")
        except:
            formatted = dt_str

        return {
            "answer": f"✅ Seu próximo agendamento é “{summary}” no dia {formatted}."
        }

    
    info = extract_date_e_periodo(user_message, openai_key)
    data_desejada = info["date"] if info else None
    periodo_desejado = info["periodo"] if info else None

    if slots and slots.get("date") and slots.get("time"):
        data_req = slots["date"]    # ex: "2025-06-10"
        print("data_req: ", data_req)
        hora_req = slots["time"]    # ex: "14:00"

        # Montar string ISO com fuso -03:00 (Brasília)
        dt_iso = f"{data_req}T{hora_req}:00-03:00"
        try:
            dt_obj_escolhido = datetime.fromisoformat(dt_iso)
            dt_obj_utc = dt_obj_escolhido.astimezone(timezone.utc)
        except:
            return {"answer": "❌ Não consegui entender a data/hora solicitada."}

        todos_eventos = obter_lista_eventos_do_google(token_jwt)
        encontro = None
        for ev in todos_eventos:
            dt_inicio_str = ev.get("start", {}).get("dateTime")
            if not dt_inicio_str:
                continue
            try:
                ev_dt = datetime.fromisoformat(dt_inicio_str).astimezone(timezone.utc)
            except:
                continue
            if ev_dt == dt_obj_utc:
                encontro = ev
                break

        if encontro:
            summary = encontro.get("summary", "(Sem título)")
            return {"answer": f"✅ Você marcou “{summary}” para {data_req} às {hora_req}."}
        else:
            return {"answer": f"❌ Não encontrei nenhum compromisso em {data_req} às {hora_req}."}

    # ─── Fallback se não condizer com nenhum padrão
    return {
        "answer": "❔ Não entendi exatamente sua pergunta sobre agendamentos. "
                  "Pergunte “Qual é o meu próximo agendamento?” ou "
                  "“Com quem agendei em YYYY-MM-DD HH:MM?”"
    }

@app.post("/api/webhook")
async def webhook_llm(
    req: QuestionRequest,
    authorization: str = Header(None)
):
    if not authorization:
        raise HTTPException(status_code=401, detail="Token JWT ausente no header Authorization")
    token_jwt = authorization.replace("Bearer ", "")

    pergunta = req.question.strip()
    texto_lower = pergunta.lower()
    agora_utc = datetime.utcnow().replace(tzinfo=timezone.utc)

    # --- 1) Primeiro, veja se é “próximo agendamento” ou “próximo compromisso” ---
    if "próximo agendamento" in texto_lower or "próximo compromisso" in texto_lower:
        # Busca todos os eventos no Google Calendar do usuário
        todos_eventos = obter_lista_eventos_do_google(token_jwt)
        futuros = []
        for ev in todos_eventos:
            dt_inicio_str = ev.get("start", {}).get("dateTime")
            if not dt_inicio_str:
                continue
            try:
                dt_obj = datetime.fromisoformat(dt_inicio_str)
            except:
                continue
            dt_utc = dt_obj.astimezone(timezone.utc)
            if dt_utc > agora_utc:
                futuros.append((dt_utc, ev))

        if not futuros:
            return {"answer": "❌ Não há agendamentos futuros."}

        # Ordena pelo start mais próximo
        futuros.sort(key=lambda x: x[0])
        evento_prox = futuros[0][1]
        summary = evento_prox.get("summary", "(Sem título)")
        dt_str = evento_prox.get("start", {}).get("dateTime")
        try:
            dt_obj_local = datetime.fromisoformat(dt_str)
            formatted = dt_obj_local.strftime("%d/%m/%Y %H:%M")
        except:
            formatted = dt_str

        return {"answer": f"✅ Seu próximo agendamento é “{summary}” no dia {formatted}."}

    # --- 2) Se não for “próximo agendamento”, cair no RAG normal ---
    # (Aqui vai exatamente o mesmo prompt + chain que você já tinha)
    # — Cria / obtém a memória daquele token_jwt:
    if token_jwt not in memorias_usuarios:
        memorias_usuarios[token_jwt] = ConversationBufferMemory(
            memory_key="chat_history",
            return_messages=True
        )

    # — Constroi o PromptTemplate que você já usa (variáveis "context" e "question"):
    prompt = PromptTemplate(
        input_variables=["context", "question"],
        template="""
Você é um assistente que ajuda o empresário com perguntas sobre agenda, clientes, tarefas ou informações gerais.
Leia primeiro este contexto extraído dos documentos (se houver):

{context}

Agora responda à pergunta abaixo de forma clara e direta (em português). Se a pergunta envolver datas/horários, seja preciso.

Pergunta: {question}
"""
    )

    # — Cria o ConversationalRetrievalChain
    chain = ConversationalRetrievalChain.from_llm(
        llm=get_llm(get_user_config(token_jwt).get("openaiKey") or os.getenv("OPENAI_API_KEY")),
        retriever=db.as_retriever(search_kwargs={"k": 3}),
        memory=memorias_usuarios[token_jwt],
        combine_docs_chain_kwargs={
            "prompt": prompt,
            "document_variable_name": "context"
        }
    )

    try:
        # Passa a “question” para o RAG
        result = chain.invoke({"question": pergunta})
        return {"answer": result["answer"]}
    except Exception as e:
        print(f"[ERROR webhook_llm]: {e}")
        raise HTTPException(status_code=500, detail="Erro interno ao gerar resposta")


class TokenPayload_(BaseModel):
    numero: str
    token: str


@app.get("/api/user-id")
def rota_user_id(info: tuple[str, str] = Depends(decode_token_completo)):
    numero, token_jwt = info
    user_id = get_user_id_por_numero(numero, token_jwt)
    if user_id:
        return {"userId": user_id}
    return {"erro": "Usuário não encontrado"}


@app.post("/generate")
async def generate(
    req: MessageRequest,
    authorization: str = Header(None)
):
    if not authorization:
        raise HTTPException(status_code=401, detail="Token JWT ausente no header Authorization")
    token_jwt = authorization.replace("Bearer ", "")

    numero_telefone = req.sender
    numero_meu = req.numeroConectado
    print(numero_meu)
    user_message = req.message

    openai_key = get_user_config(token_jwt).get("openaiKey") or os.environ.get("OPENAI_API_KEY")

    # Salvar mensagem do usuário na memória
    ext = extract_name_and_phone_llm(user_message,  openai_key or os.environ.get("OPENAI_API_KEY"))
    numero_telefone = req.sender
    numero_meu = req.numeroConectado
    save_memory_to_db(
        numero=numero_telefone,
        who="user",
        text=user_message,
        token_jwt=token_jwt,
        name=ext.get("name"),
        phone=ext.get("phone")
    )



    # Chamar generate_response (que faz todo o fluxo de agendamento/estado)
    resposta = generate_response(numero_telefone, user_message, token_jwt)
    save_memory_to_db(
        numero=numero_telefone,
        who="bot",
        text=resposta,
        token_jwt=token_jwt,
        name=ext.get("name"),
        phone=ext.get("phone")
    )
    return resposta