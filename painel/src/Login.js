// Login.js
import 'bootstrap/dist/css/bootstrap.min.css';
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { jwtDecode } from 'jwt-decode';
import logo_supernova from './assets/logo_supernova.jpeg';

function useMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 480);
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 480);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  return isMobile;
}

function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isHovered, setIsHovered] = useState(false);
  const [msg, setMsg] = useState('');
  const isMobile = useMobile();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();

    try {
      const res = await fetch('http://localhost:3001/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: username, senha: password })
      });

      const data = await res.json();
      console.log(data)
      setMsg(data.msg);

      if (data.ok && data.token) {
        // Decodifica o JWT para obter nome e número (já inclusos no payload)
        const payload = jwtDecode(data.token);
        // payload = { id, nome, numero, iat, exp }

        // Guarda apenas o token; nome e número podem ser extraídos quando necessário
        const authObj = { token: data.token };
        localStorage.setItem('auth', JSON.stringify(authObj));

        // Opcional: se quiser exibir o nome imediatamente, poderia usar payload.nome aqui
        setMsg(`Bem-vindo(a), ${payload.nome}!`);

        navigate('/painel');
      }
    } catch {
      setMsg('Erro ao conectar ao servidor.');
    }
  };

  return (
    <div className="d-flex justify-content-center align-items-center min-vh-100 bg-light p-3">
      <form
        onSubmit={handleSubmit}
        className={`bg-white p-4 rounded shadow ${isMobile ? 'w-100' : 'w-50'} mx-2`}
        style={{ maxWidth: '400px' }}
      >
        <div className="d-flex justify-content-center mb-3">
          <img
            src={logo_supernova}
            alt="Logo"
            style={{ width: isMobile ? '90px' : '150px', borderRadius: '8px' }}
          />
        </div>
        <p
          className="text-center text-secondary mb-4"
          style={{ fontFamily: 'Roboto, sans-serif', fontSize: isMobile ? '14px' : '15px' }}
        >
          Que bom ter você de volta! Nosso agente de IA está pronto pra turbinar suas conversas no WhatsApp!
        </p>

        <input
          type="text"
          placeholder="Email"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="form-control mb-3"
          required
          style={{ fontSize: isMobile ? '15px' : '16px' }}
        />
        <input
          type="password"
          placeholder="Senha"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="form-control mb-3"
          required
          style={{ fontSize: isMobile ? '15px' : '16px' }}
        />

        <button
          type="submit"
          className={`btn btn-dark w-100 fw-bold ${isHovered ? 'shadow-sm' : ''}`}
          style={{ fontSize: isMobile ? '15px' : '16px' }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          Entrar
        </button>

        {msg && (
          <div
            className={`mt-3 text-center ${
              msg.toLowerCase().includes('bem-vindo') ? 'text-success' : 'text-danger'
            }`}
            style={{ fontWeight: '600' }}
          >
            {msg}
          </div>
        )}

        <div className="d-flex flex-column align-items-center mt-4 gap-2">
          <a href="/esqueci-senha" className="text-primary" style={{ fontSize: isMobile ? '14px' : '15px' }}>
            Esqueci minha senha
          </a>
          <a href="/cadastro" className="text-secondary text-decoration-underline" style={{ fontSize: isMobile ? '14px' : '15px' }}>
            Não tenho conta? Criar agora
          </a>
        </div>
      </form>
    </div>
  );
}

export default Login;
