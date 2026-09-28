# Configuração Firebase

O projeto está apontado para `site-de-delivery-9ed15`. O cliente usa Firebase Authentication com e-mail/senha e Firestore para perfis, catálogo, pedidos e imagens PNG pequenas (limite de 450 KB por arquivo). O checkout usa Cloud Functions para criar pagamentos no Mercado Pago sem expor o Access Token no navegador. As regras de acesso estão em `firestore.rules`.

## Ativar serviços

1. No Firebase Console, abra o projeto `site-de-delivery-9ed15`.
2. Em **Authentication > Sign-in method**, habilite **E-mail/senha**.
3. Em **Firestore Database**, crie o banco de dados padrão. A leitura pública do catálogo e gravações restritas dependem das regras do repositório.
4. Em **Authentication > Users**, crie a conta `thiegoluiz8@gmail.com`. Ao entrar pela primeira vez no site, o Firebase enviará um link para verificar o e-mail. Abra o link e entre novamente para acessar a área do proprietário.

## Publicar regras

Entre na conta Google com acesso ao projeto e publique as regras pelo PowerShell:

```powershell
npx.cmd --yes firebase-tools login
npx.cmd --yes firebase-tools deploy --only firestore:rules --project site-de-delivery-9ed15
```

A aplicação deve ser aberta por HTTP/HTTPS; imports de módulos Firebase não funcionam usando `file://`. A API key web no `script.js` identifica o projeto e não substitui as regras de segurança. Não armazene senhas manualmente no Firestore.

## Mercado Pago (Checkout Pro)

1. No [Mercado Pago Developers](https://www.mercadopago.com.br/developers/panel), crie uma aplicação para Checkout Pro e copie primeiro o Access Token de teste.
2. No Google Cloud, crie os segredos vazios e habilite a API do Secret Manager. No PowerShell, use:

```powershell
gcloud.cmd services enable secretmanager.googleapis.com --project site-de-delivery-9ed15
gcloud.cmd secrets create MP_ACCESS_TOKEN --replication-policy=automatic --project site-de-delivery-9ed15
gcloud.cmd secrets create MP_WEBHOOK_SECRET --replication-policy=automatic --project site-de-delivery-9ed15
```

3. Conceda ao service account padrão das funções acesso apenas a esses dois segredos. O número do projeto é `690119803718`; se a função usar um service account personalizado, substitua o e-mail abaixo pelo exibido na configuração da função:

```powershell
gcloud.cmd secrets add-iam-policy-binding MP_ACCESS_TOKEN --member="serviceAccount:690119803718-compute@developer.gserviceaccount.com" --role=roles/secretmanager.secretAccessor --project site-de-delivery-9ed15
gcloud.cmd secrets add-iam-policy-binding MP_ACCESS_TOKEN --member="serviceAccount:690119803718-compute@developer.gserviceaccount.com" --role=roles/secretmanager.secretVersionAdder --project site-de-delivery-9ed15
gcloud.cmd secrets add-iam-policy-binding MP_WEBHOOK_SECRET --member="serviceAccount:690119803718-compute@developer.gserviceaccount.com" --role=roles/secretmanager.secretAccessor --project site-de-delivery-9ed15
gcloud.cmd secrets add-iam-policy-binding MP_WEBHOOK_SECRET --member="serviceAccount:690119803718-compute@developer.gserviceaccount.com" --role=roles/secretmanager.secretVersionAdder --project site-de-delivery-9ed15
```

4. Publique as regras e funções:

```powershell
npx.cmd --yes firebase-tools deploy --only firestore:rules,functions --project site-de-delivery-9ed15
```

Cloud Functions exige que o projeto Firebase esteja no plano Blaze (com faturamento configurado). Entre na loja com a conta proprietária verificada, abra **Gerenciar produtos > Mercado Pago** e informe o Access Token de teste. Os campos são enviados ao backend e gravados no Secret Manager; o site nunca os mostra novamente.

5. Obtenha a URL da função `mercadoPagoWebhook`:

```powershell
npx.cmd --yes firebase-tools functions:list --project site-de-delivery-9ed15
```

6. No painel do Mercado Pago, abra sua aplicação > **Webhooks**, cadastre essa URL e habilite o evento **Pagamentos**. Copie a assinatura secreta gerada, volte à aba **Mercado Pago** da loja e informe somente essa chave para salvá-la. O campo Access Token vazio mantém o valor atual.

7. Faça uma compra de teste com as credenciais de teste. Para receber pagamentos reais, substitua o Access Token pela credencial de produção na aba **Mercado Pago**. Nunca use o Access Token em código do navegador.
