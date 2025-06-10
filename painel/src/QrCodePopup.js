import React, { useEffect, useState } from "react";
import axios from "axios";

function QrCodePopup({ open, onClose }) {
  const [qr, setQr] = useState(null);

  useEffect(() => {
    if (!open) return;
    setQr(null);
    const fetchQr = async () => {
      try {
        const res = await axios.get("http://localhost:3335/api/whatsapp-qr");
        setQr(res.data.qr);
      } catch { setQr(null); }
    };
    fetchQr();
    const timer = setInterval(fetchQr, 2500);
    return () => clearInterval(timer);
  }, [open]);

  if (!open) return null;

  return (
    <div style={{ /* estilização do modal */ }}>
      <button onClick={onClose}>Fechar</button>
      {qr ? <img src={qr} alt="QR Code WhatsApp" /> : <div>Carregando QR...</div>}
    </div>
  );
}

export default QrCodePopup;
