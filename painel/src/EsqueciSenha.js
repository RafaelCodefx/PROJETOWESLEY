import React, { useState } from 'react';

function EsqueciSenha() {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    // Aqui você enviaria o email para o backend para recuperação
    setMsg('Se este e-mail existir, você receberá as instruções em instantes.');
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f9f9f9'
    }}>
      <form
        onSubmit={handleSubmit}
        style={{
          background: '#fff', padding: '2rem', borderRadius: 12, boxShadow: '0 2px 12px rgba(36, 52, 94, 0.07)', maxWidth: 340, width: '100%', display: 'flex', flexDirection: 'column', gap: 20
        }}
      >
        <h2 style={{ textAlign: 'center', color: '#007bff', marginBottom: 12 }}>Recuperar senha</h2>
        <input
          type="email"
          placeholder="Seu e-mail cadastrado"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          style={{ padding: 12, borderRadius: 6, border: '1px solid #ddd' }}
        />
        <button type="submit" style={{ padding: 12, borderRadius: 6, background: '#007bff', color: '#fff', fontWeight: 'bold', border: 'none', cursor: 'pointer' }}>
          Enviar link de recuperação
        </button>
        {msg && <div style={{ color: '#28a745', textAlign: 'center' }}>{msg}</div>}
      </form>
    </div>
  );
}

export default EsqueciSenha;
