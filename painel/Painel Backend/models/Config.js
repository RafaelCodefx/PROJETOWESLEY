
const ConfigSchema = new mongoose.Schema({
  userId: { type: mongoose.Types.ObjectId, ref: 'Usuario', required: true, unique: true },
  customInstructions: { type: String, default: '' },
  openaiKey: { type: String, default: '' },
  asaasKey: { type: String, default: '' },
  googleClientId: { type: String, default: '' },
  googleClientSecret: { type: String, default: '' },
  googleAccessToken: { type: String, default: '' },
  googleRefreshToken: { type: String, default: '' },
  googleTokenExpiryDate: { type: Number, default: 0 },
}, { timestamps: true });
