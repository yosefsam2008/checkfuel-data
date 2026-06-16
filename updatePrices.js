const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');

async function scrapePrices() {
  const filePath = 'public/prices.json';
  
  try {
    console.log('Fetching live prices...');
    // 1. קריאת האתר
    const { data } = await axios.get('https://www.israelhayom.co.il/gas-prices', {
      headers: { 'User-Agent': 'Mozilla/5.0' } 
    });
    
    const $ = cheerio.load(data);

    // 2. חיפוש המחיר (מנסים כמה אפשרויות נפוצות ב-HTML של האתר)
    let rawPrice = $('#FulePriceBensin95').text() || $('.fuel-price').first().text();
    let newGasolinePrice = null;

    if (rawPrice) {
      // ניקוי הטקסט כדי להשאיר רק את המספר העשרוני
      const cleanPrice = parseFloat(rawPrice.replace(/[^\d.]/g, ''));
      // בדיקת הגיוניות: מחיר דלק בישראל נע לרוב בין 6 ל-9 שקלים
      if (cleanPrice > 5 && cleanPrice < 10) {
        newGasolinePrice = cleanPrice.toString();
      }
    }

    // 3. קריאת הקובץ הקיים כדי לא לדרוס נתונים אחרים (כמו חשמל/סולר)
    let currentData = { Gasoline: "7.36", Diesel: "9.58", Electric: "0.60" };
    if (fs.existsSync(filePath)) {
      currentData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }

    // 4. אם מצאנו מחיר חדש ותקין, נעדכן. אם לא, נשמור את הישן.
    if (newGasolinePrice) {
      currentData.Gasoline = newGasolinePrice;
      console.log(`Successfully scraped new price: ₪${newGasolinePrice}`);
    } else {
      console.log('Could not find a valid price on the site, keeping existing prices.');
    }

    // 5. כתיבה חזרה לקובץ
    fs.writeFileSync(filePath, JSON.stringify(currentData, null, 2));
    console.log('File public/prices.json updated!');

  } catch (error) {
    console.error('Scraping failed:', error.message);
    process.exit(1); // עוצר את האוטומציה עם שגיאה כדי שתקבל התראה מ-GitHub
  }
}

scrapePrices();
