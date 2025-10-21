const http = require('http');

function testAPI() {
    console.log('🔍 Testing API Connection...');
    
    const options = {
        hostname: 'localhost',
        port: 3000,
        path: '/api/v1/klines?market=TATA_INR&interval=1m&startTime=1760286250&endTime=1760891050',
        method: 'GET'
    };
    
    const req = http.request(options, (res) => {
        console.log(`📊 API Status: ${res.statusCode}`);
        
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });
        
        res.on('end', () => {
            console.log('📈 API Response:');
            console.log(data);
            
            if (res.statusCode === 200) {
                console.log('✅ API is working! Charts should display.');
            } else {
                console.log('❌ API returned error status');
            }
        });
    });
    
    req.on('error', (err) => {
        console.log('❌ API Connection Failed:', err.message);
        console.log('💡 Make sure API server is running: cd ../api && npm run dev');
    });
    
    req.end();
}

testAPI();
