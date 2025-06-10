const { Client, LocalAuth, List } = require('whatsapp-web.js');

const client = new Client({
    authStrategy: new LocalAuth({ clientId: "client-one" }),
    puppeteer: {
        headless: false,
        args: ['--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-extensions',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // <- this one doesn't works in Windows
            '--disable-gpu']
    }
});

client.on('ready', async () => {
    const number = "96883493";
    const sanitized_number = number.toString().replace(/[- )(]/g, ""); // remove unnecessary chars from the number
    const final_number = `55${sanitized_number.substring(sanitized_number.length - 10)}`; // add 91 before the number here 91 is country code of India

    const number_details = await client.getNumberId(final_number); // get mobile number details

    const productsList = new List(
        "Amazing deal on these products",
        "View products",
        [
            {
                title: "Products list",
                rows: [
                    { id: "apple", title: "Apple" },
                    { id: "mango", title: "Mango" },
                    { id: "banana", title: "Banana" },
                ],
            },
        ],
        "Please select a product"
    );

    if (number_details) {
        const sendMessageData = await client.sendMessage(number_details._serialized, productsList); // send message
        console.log('msg sent now closing ', sendMessageData)
        setTimeout(() => {
            client.destroy()
        }, 20000);
    } else {
        console.log(final_number, "Mobile number is not registered");
    }
});

client.initialize()
