import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import logo_supernova from './assets/logo_supernova.jpeg';
import 'bootstrap/dist/css/bootstrap.min.css';

function useMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 480);
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 480);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  return isMobile;
}

function Cadastro() {
  const [email, setEmail] = useState('');
  const [nome, setNome] = useState('');
  const [senha, setSenha] = useState('');
  const [confirmsenha, setconfirmsenha] = useState('');
  const [msg, setMsg] = useState('');
  const [numero, setNumero] = useState('');
  const navigate = useNavigate();
  const isMobile = useMobile();

  const handleChange = (e) => {
    const input = e.target.value.replace(/\D/g, '');
    if (input.length <= 13) setNumero(input);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (senha !== confirmsenha) {
      setMsg('As senhas não conferem!');
      return;
    }
    if (!numero || !email || !senha || !confirmsenha || !nome) {
      setMsg('Existem Dados não preenchidos.');
      return;
    }

    if (!/^\d{12}$/.test(numero)) {
      setMsg('O número deve conter exatamente 12 dígitos no formato: 556699738750');
      return;
    }

    try {
      console.log({ nome, numero, email, senha });
      const res = await fetch('http://localhost:3001/api/cadastro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome, numero, email, senha })
      });
      
      const data = await res.json();

      if (data.erros) {
        // Exibe o primeiro erro
        setMsg(data.erros[0].msg);
      } else {
        setMsg(data.msg);
      }


      if (data.ok) {
        setEmail('');
        setNome('');
        setSenha('');
        setconfirmsenha('');
        setNumero('');
        setTimeout(() => navigate('/'), 1000);
      }
    } catch (err) {
      setMsg('Erro ao cadastrar!');
    }
  };

  return (
    <div className="min-vh-100 d-flex align-items-center justify-content-center bg-light">
      <form onSubmit={handleSubmit} className="bg-white p-4 rounded shadow" style={{ maxWidth: 400, width: '100%' }}>
        <div className={`d-flex ${isMobile ? 'justify-content-center' : 'justify-content-start'} mb-2`}>
          <img src={logo_supernova} alt="Logo" className="rounded" style={{ width: isMobile ? 90 : 150 }} />
        </div>

        <div className="mb-3 text-secondary small" style={{ fontFamily: 'roboto' }}>
          <p className="mb-1">Vamos Juntos Criar Sua Conta!</p>
          <p className="mb-0">Por favor, preencha o formulário abaixo:</p>
        </div>

        <h2 className="text-primary text-center mb-3 fs-4">Criar conta</h2>

        <div className="mb-3">
          <input
            type="text"
            className="form-control"
            placeholder="Seu nome"
            value={nome}
            onChange={e => setNome(e.target.value)}
            required
          />
        </div>

        <div className="mb-3">
          <input
            type="text"
            className="form-control"
            placeholder="Número de WhatsApp"
            value={numero}
            onChange={handleChange}
            required
          />
        </div>

        <div className="mb-3">
          <input
            type="email"
            className="form-control"
            placeholder="Seu e-mail"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="mb-3">
          <input
            type="password"
            className="form-control"
            placeholder="Senha"
            value={senha}
            onChange={e => setSenha(e.target.value)}
            required
          />
        </div>

        <div className="mb-3">
          <input
            type="password"
            className="form-control"
            placeholder="Confirmar Senha"
            value={confirmsenha}
            onChange={e => setconfirmsenha(e.target.value)}
            required
          />
        </div>

        <button type="submit" className="btn btn-success w-100 fw-bold mb-3">
          Cadastrar
        </button>

        {msg && (
          <div className={`text-center ${msg.includes('sucesso') ? 'text-success' : 'text-danger'} mb-2`}>
            {msg}
          </div>
        )}

        <div className="text-center">
          <a href="/" className="text-primary text-decoration-underline fw-medium">Já tenho Conta! Quero fazer login</a>
        </div>
      </form>
    </div>
  );
}

export default Cadastro;
