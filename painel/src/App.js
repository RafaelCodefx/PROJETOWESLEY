//app.js
import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Login from './Login';
import EsqueciSenha from './EsqueciSenha';
import Cadastro from './Cadastro';
import Painel from './Painel';
import ProtectedRoute from './ProtectedRoute'; // importe aqui

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Login />} />
        <Route path="/esqueci-senha" element={<EsqueciSenha />} />
        <Route path="/cadastro" element={<Cadastro />} />

        {/* Tudo que estiver dentro do ProtectedRoute só acessa se estiver logado */}
        <Route element={<ProtectedRoute />}>
          <Route path="/painel" element={<Painel />} />
        </Route>
        
      </Routes>
    </BrowserRouter>
  );
}

export default App;
