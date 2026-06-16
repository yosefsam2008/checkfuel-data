const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');

async function scrapePrices() {
  const filePath = 'public/prices.json';
  
  try {
    console.log('Fetching live prices from Dor Alon...');
    
    // 1. קריאת האתר הרשמי והיציב של דור אלון
    const { data } = await axios.get('https://www.doralon.co.il/fuels-price/', {
      headers: { 
        // אנו מזדהים כדפדפן רגיל כדי שהשרת לא יחסום אותנו
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
      } 
    });
    
    const $ = cheerio.load(data);

    // 2. ה"קסם": במקום לחפש אלמנט עיצובי שעלול להשתנות, אנחנו קוראים את כל הטקסט החשוף באתר
    const pageText = $('body').text().replace(/\s+/g, ' '); 
    
    // 3. שימוש ב-Regex כדי לצוד את המספר בפורמט (X.XX) שמופיע מיד אחרי שם הדלק
    const matchGasoline = pageText.match(/בנזין 95[^\d]*?(\d\.\d{2})/);
    const matchDiesel = pageText.match(/סולר[^\d]*?(\d{1,2}\.\d{2})/);

    let newGasolinePrice = matchGasoline ? matchGasoline[1] : null;
    let newDieselPrice = matchDiesel ? matchDiesel[1] : null;

    // 4. קריאת קובץ הנתונים הקיים כדי לא לדרוס את מחיר החשמל
    let currentData = { Gasoline: "7.36", Diesel: "9.58", Electric: "0.60" };
    if (fs.existsSync(filePath)) {
      currentData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }

    // 5. אימות והגנה: מוודאים שמצאנו מחיר הגיוני (בין 5 ל-10 שקלים)
    if (newGasolinePrice && parseFloat(newGasolinePrice) > 5 && parseFloat(newGasolinePrice) < 10) {
      currentData.Gasoline = newGasolinePrice;
      console.log(`✅ Successfully scraped Gasoline 95: ₪${newGasolinePrice}`);
    } else {
      console.log('⚠️ Could not find valid Gasoline price, keeping existing fallback price.');
    }

    if (newDieselPrice && parseFloat(newDieselPrice) > 5) {
      currentData.Diesel = newDieselPrice;
      console.log(`✅ Successfully scraped Diesel: ₪${newDieselPrice}`);
    }

    // 6. כתיבה חזרה לקובץ ושמירה
    fs.writeFileSync(filePath, JSON.stringify(currentData, null, 2));
    console.log('🎉 File public/prices.json updated successfully!');

  } catch (error) {
    console.error('❌ Scraping failed:', error.message);
    process.exit(1); // עוצר את התהליך כדי שתקבל התראה אדומה ב-GitHub אם יש קריסה
  }
}

scrapePrices();
