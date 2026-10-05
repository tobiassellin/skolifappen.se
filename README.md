<!DOCTYPE html>
<html lang="sv">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Skol IF Appen - Det digitala verktyget för idrottslärare</title>
    <!-- Hämtar ett modernt typsnitt från Google Fonts -->
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;600;800&display=swap" rel="stylesheet">
    
    <style>
        /* Grundläggande inställningar */
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: 'Poppins', sans-serif;
        }
        body {
            background-color: #F8F9FA;
            color: #333;
            line-height: 1.6;
        }

        /* Navigationsmeny högst upp */
        nav {
            background-color: #4CAF50; /* Appens gröna färg */
            padding: 1rem 5%;
            display: flex;
            justify-content: space-between;
            align-items: center;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            flex-wrap: wrap;
        }
        .logo {
            color: white;
            font-size: 1.5rem;
            font-weight: 800;
            text-decoration: none;
            letter-spacing: 1px;
        }
        .nav-links {
            display: flex;
            gap: 20px;
        }
        .nav-links a {
            color: white;
            text-decoration: none;
            font-weight: 600;
            transition: color 0.3s;
            font-size: 1rem;
        }
        .nav-links a:hover {
            color: #C8E6C9;
        }

        /* Välkomstsektionen (Hero) */
        .hero {
            text-align: center;
            padding: 100px 20px;
            background-color: #ffffff;
            border-bottom: 1px solid #eee;
        }
        .hero h1 {
            font-size: 3rem;
            color: #2E7D32;
            margin-bottom: 20px;
        }
        .hero p {
            font-size: 1.2rem;
            color: #666;
            max-width: 600px;
            margin: 0 auto 30px auto;
        }
        .cta-button {
            display: inline-block;
            background-color: #4CAF50;
            color: white;
            padding: 15px 30px;
            border-radius: 30px;
            text-decoration: none;
            font-weight: bold;
            font-size: 1.1rem;
            transition: transform 0.2s, background-color 0.2s;
            box-shadow: 0 4px 15px rgba(76, 175, 80, 0.4);
        }
        .cta-button:hover {
            background-color: #388E3C;
            transform: translateY(-2px);
        }

        /* Sektion för funktioner (Cards) - NY DESIGN FÖR SAMMA RAD */
        .features-container {
            max-width: 1200px;
            margin: 0 auto;
        }
        .features {
            display: flex;
            justify-content: center;
            gap: 20px;
            padding: 60px 5%;
            flex-wrap: nowrap; /* Tvingar dem att stanna på samma rad på dator */
        }
        .card {
            background: white;
            border-radius: 12px;
            padding: 30px;
            flex: 1; /* Gör så att korten delar jämnt på utrymmet i bredd */
            box-shadow: 0 4px 10px rgba(0,0,0,0.05);
            text-align: center;
            transition: transform 0.3s;
        }
        .card:hover {
            transform: translateY(-5px);
            box-shadow: 0 8px 20px rgba(0,0,0,0.1);
        }
        .card-icon {
            font-size: 3rem;
            margin-bottom: 15px;
        }
        .card h3 {
            color: #2E7D32;
            margin-bottom: 15px;
            font-size: 1.3rem;
        }
        .card p {
            font-size: 0.95rem;
            color: #555;
        }

        /* Sidfot (Footer) */
        footer {
            background-color: #333;
            color: white;
            text-align: center;
            padding: 20px;
            margin-top: 40px;
            font-size: 0.9rem;
        }

        /* Mobilanpassning */
        @media (max-width: 768px) {
            nav {
                flex-direction: column;
                gap: 15px;
            }
            .hero h1 {
                font-size: 2.2rem;
            }
            .features {
                flex-direction: column; /* Ändrar tillbaka till kolumn på mobiler */
                align-items: center;
            }
            .card {
                width: 100%;
                max-width: 350px;
            }
        }
    </style>
</head>
<body>

    <!-- NAVIGERING -->
    <nav>
        <a href="#" class="logo">Skol IF Appen</a>
        <div class="nav-links">
            <a href="#kassa">Skol IF Kassa</a>
            <a href="#redskapsboden">Redskapsboden</a>
            <a href="#turnering">Skapa Turnering</a>
        </div>
    </nav>

    <!-- HERO SEKTION -->
    <header class="hero">
        <h1>Förenkla vardagen för din Skol-IF</h1>
        <p>Det kompletta digitala verktyget för idrottslärare och Skol-IF-ledare. Samla kioskkassan, utlåning och spelscheman på ett och samma ställe.</p>
        <a href="https://play.google.com/store/apps/details?id=com.sellin.tabatatimer" target="_blank" class="cta-button">
            Ladda ner på Google Play
        </a>
    </header>

    <!-- FUNKTIONER -->
    <div class="features-container">
        <section class="features">
            <div class="card" id="kassa">
                <div class="card-icon">☕</div>
                <h3>Skol IF Kassa</h3>
                <p>Håll enkelt koll på elevsaldon, Swish-insättningar och kioskköp. Exportera en komplett och prydlig redovisning till Excel med ett enda knapptryck.</p>
            </div>

            <div class="card" id="redskapsboden">
                <div class="card-icon">📦</div>
                <h3>Redskapsboden</h3>
                <p>Ett smidigt digitalt system för att låna ut material. Se exakt vem som har lånat vilken utrustning, så inget tappas bort under rasterna.</p>
            </div>

            <div class="card" id="turnering">
                <div class="card-icon">🏆</div>
                <h3>Skapa Turnering</h3>
                <p>Generera kompletta spelscheman på sekunder. Registrera resultat direkt i appen och låt systemet automatiskt sköta tabeller och slutspelsträd.</p>
            </div>
        </section>
    </div>

    <!-- FOOTER -->
    <footer>
        <p>&copy; 2026 Skol IF Appen. Utvecklad av Tobias, idrotts- och matematiklärare.</p>
    </footer>

</body>
</html>
