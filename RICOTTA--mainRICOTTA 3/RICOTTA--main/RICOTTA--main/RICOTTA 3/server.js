const express = require('express');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// הגדרת תיקיית הקבצים הסטטיים (איפה שנמצא ה-HTML)
app.use(express.static(path.join(__dirname, 'public')));

// ניתוב ראשי - מחזיר את דף הבית
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// הפעלת השרת
app.listen(port, () => {
    console.log(`🍩 Ricotta Server is running on port ${port}`);
});