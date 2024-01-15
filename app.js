    const express = require('express');
    const bodyParser = require('body-parser');
    const Web3 = require('web3');
    const fs = require('fs');
    const path = require('path');
    const app = express();
    const csv = require('csv-parser');

    const {GasPrice, calculateFee} = require("@cosmjs/stargate");
    const {SigningCosmWasmClient} = require("@cosmjs/cosmwasm-stargate");
    const {DirectSecp256k1Wallet} = require('@cosmjs/proto-signing');
    const {fromHex} = require('@cosmjs/encoding');
    const fetch = require('node-fetch');
    const HttpsProxyAgent = require('https-proxy-agent');

    app.use(bodyParser.json());
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));
    app.use(express.urlencoded({extended: true}));

    const rpcEndpoints = [
        'https://rpc.sei-apis.com/',
        'https://sei-rpc.brocha.in/',
        'https://sei-rpc.polkachu.com/',
        'https://rpc.atlantic-2.seinetwork.io/',
        'https://sei-a2-rpc.brocha.in/'
    ];
    const contractAddress = "sei1hjsqrfdg2hvwl3gacg4fkznurf36usrv7rkzkyh29wz3guuzeh0snslz7d";
    const collectionAddress = "sei1va06zjmjyjrhmqnepznt6z94hnd2dssj489rh4pggv5uaxphzc0qyhec5c";

    // Путь к вашему CSV файлу
    const filePath = path.join(__dirname, 'wallets.txt');

    // Массив мнемоник
    let walletData;
    let isOperationStopped;

    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    let currentProxyIndex = 0;

    let maxTransactionsPerWallet = 1; // Например, максимум 10 транзакций на кошелек
    let successfulTransactions = {}; // Для отслеживания количества успешных транзакций

    app.post('/start', async (req, res) => {
        //const { proxiesList, maxTransactionsPerWallet: maxTrans } = req.body;
        const {  maxTransactionsPerWallet: maxTrans } = req.body;
        maxTransactionsPerWallet = parseInt(maxTrans, 1) || 1; // Устанавливаем значение по умолчанию, если не указано
        try {
            await executeMultipleTransactions();
            res.send('Start');
        } catch (error) {
            res.status(500).send('Error: ' + error.message);
        }
    });

    app.post('/stop', (req, res) => {
        isOperationStopped = true;
        successfulTransactions = {}; // Сбросить счетчик успешных транзакций
        res.send('Stopping transactions');
    });


    let attemptCount = 0;
    const getAvailableRpcEndpoint = async () => {
        if (attemptCount == rpcEndpoints.length - 1) attemptCount = 0;
        while (attemptCount < rpcEndpoints.length) {
            let options = {};

            const endpoint = rpcEndpoints[attemptCount];
            try {
                const response = await fetch(endpoint, options);
                if (response.ok) {
                    return endpoint;
                } else if (response.status === 503 || response.status === 429) {
                    console.log(`RPC endpoint ${endpoint} responded with ${response.status}. Switching to next endpoint.`);
                    attemptCount++;
                    continue;
                }
            } catch (error) {
                console.log(`Error accessing RPC endpoint ${endpoint}:`, error.message);
            }

            attemptCount++;
            console.log(`Switching to next endpoint due to failure: ${rpcEndpoints[attemptCount]}`);
            await delay(500); // Wait before retrying
        }

        throw new Error('No available RPC endpoints');
    };

    const ensureFileExists = (filePath) => {
        if (!fs.existsSync(filePath)) {
            console.log(`Файл ${filePath} не найден. Создание файла с заголовками...`);
            fs.writeFileSync(filePath, 'Private\n', 'utf8');
            console.log(`Файл ${filePath} создан. Пожалуйста, заполните его и перезапустите программу.`);
            process.exit(1);
        }
    };
    ensureFileExists(filePath);

    // Функция для чтения данных из текстового файла
    const readPrivateKeysFromTextFile = async (filePath) => {
        return new Promise((resolve, reject) => {
            const privateKeys = [];

            const stream = fs.createReadStream(filePath, 'utf8');

            stream.on('data', (chunk) => {
                const lines = chunk.split('\n');
                lines.forEach(line => {
                    const privateKey = line.trim();
                    if (privateKey) {
                        privateKeys.push(privateKey);
                    }
                });
            });

            stream.on('end', () => {
                resolve(privateKeys);
            });

            stream.on('error', (error) => {
                reject(error);
            });
        });
    };

    readPrivateKeysFromTextFile(filePath)
        .then(privateKeys => {
            walletData = privateKeys; // Сохраняем приватные ключи в переменной walletData
            console.log('Приватные ключи загружены:');
        })
        .catch(error => console.error('Ошибка при чтении текстового файла:', error));

    // Функция для отправки транзакции
    const executeTransaction = async (privateKey) => {
        const privateKeyUint8Array = fromHex(privateKey);
        const signer = await DirectSecp256k1Wallet.fromKey(privateKeyUint8Array, "sei");
        const [sender] = await signer.getAccounts();
        try {
            if (isOperationStopped) {
                console.log('Transaction stopped during execution');
                return { status: 'Stopped', message: 'Transaction stopped' };
            }
            const rpcEndpoint = await getAvailableRpcEndpoint();

            const client = await SigningCosmWasmClient.connectWithSigner(
                rpcEndpoint,
                signer,
                {
                    gasPrice: GasPrice.fromString("0.05usei"),
                }
            );

            const fee = calculateFee(600000, "0.1usei");
            const msg = {
                "mint_native": {
                    "collection": collectionAddress,
                    "group": "Public",
                    "hashed_address": null,
                    "merkle_proof": null,
                    "recipient": sender.address
                }
            };
            // const funds = [{
            //     "denom": "usei",
            //     "amount": "41500000"
            // }];
            const tx = await client.execute(
                sender.address,
                contractAddress,
                msg,
                fee,
                undefined,
            //      funds
            );

            if (tx) {
                // Обновляем количество успешных транзакций для кошелька
                const walletAddress = sender.address;
                successfulTransactions[walletAddress] = (successfulTransactions[walletAddress] || 0) + 1;
                // Проверяем, достигнут ли лимит транзакций для кошелька
                if (successfulTransactions[walletAddress] >= maxTransactionsPerWallet) {
                    console.log(`Достигнуто максимальное количество транзакций для кошелька ${walletAddress}`);
                    return { status: 'limit_reached', address: walletAddress };
                }
            }
            console.log(`Транзакция успешно отправлена с кошелька ${sender.address}, хеш: ${tx.transactionHash}`);
            return { status: 'success', address: sender.address, txHash: txHash };
        } catch (error) {
            console.log(`Повторная попытка отправки транзакции...  ${sender.address}, ${error} `);
            await delay(1); // Задержка в 1 миллисекунду
            await executeTransaction(privateKey); // Рекурсивный вызов для повторной попытки
        }
    };
    // Функция для отправки транзакций с разных кошельков
    const executeMultipleTransactions = async () => {
        const transactions = walletData.map(async (privateKey) => {
            // Remove the '0x' prefix if present
            if (privateKey.startsWith("0x")) {
                privateKey = privateKey.substring(2);
            }

            // Ensure the private key has an even length
            if (privateKey.length % 2 !== 0) {
                privateKey = '0' + privateKey;
            }

            try {
                await executeTransaction(privateKey);
                return { status: 'success' };
            } catch (error) {
                console.log(`Ошибка при отправке транзакции: ${error}`);
                return { status: 'error', error };
            }
        });

        try {
            const results = await Promise.all(transactions);
            const success = results.find(r => r && r.status === 'success');

            if (isOperationStopped) {
                console.log('Operation was stopped. No further transactions will be processed.');
            } else if (success) {
                console.log('Одна из транзакций успешно выполнена',success);
            } else {
                console.log('Все транзакции завершились ошибкой, повторяем попытку...');
                await executeMultipleTransactions();
            }
        } catch (error) {
            console.error('Неожиданная ошибка:', error);
            if (!isOperationStopped) {
                await executeMultipleTransactions();
            }
        }
    };

    app.get('/', (req, res) => res.sendFile(path.join(__dirname, '/index.html')));
    app.listen(3000, () => console.log('Listening on port 3000'));