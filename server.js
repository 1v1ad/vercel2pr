const express = require('express');
const cors    = require('cors');

const app = express();

app.use(cors());
app.use(express.json());               // ← НУЖНО до роутов!

app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/user', require('./src/routes/user'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
