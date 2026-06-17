const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Test endpoint
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    status: 'Server running',
    time: new Date().toLocaleString('id-ID')
  });
});

// Start server
app.listen(PORT, () => {
  console.log('\n✅ SERVER RUNNING AT http://localhost:' + PORT + '\n');
});