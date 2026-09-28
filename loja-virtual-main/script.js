import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import {
	createUserWithEmailAndPassword,
	getAuth,
	onAuthStateChanged,
	sendEmailVerification,
	signInWithEmailAndPassword,
	signOut,
	updateProfile
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
	collection,
	addDoc,
	deleteDoc,
	doc,
	getDoc,
	getFirestore,
	getDocs,
	onSnapshot,
	setDoc,
	writeBatch
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const firebaseConfig = {
	apiKey: 'AIzaSyC0a1XNhTdsyzPj7Q1EwzwJ6fk2R76QCLk',
	authDomain: 'site-de-delivery-9ed15.firebaseapp.com',
	projectId: 'site-de-delivery-9ed15',
	storageBucket: 'site-de-delivery-9ed15.firebasestorage.app',
	messagingSenderId: '690119803718',
	appId: '1:690119803718:web:2ed34ee0256386d0c3db47'
};

const OWNER_EMAIL = 'thiegoluiz8@gmail.com';
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const functions = getFunctions(firebaseApp, 'us-central1');
const createMercadoPagoPreference = httpsCallable(functions, 'createMercadoPagoPreference');
const getMercadoPagoSettings = httpsCallable(functions, 'getMercadoPagoSettings');
const saveMercadoPagoSettingsCall = httpsCallable(functions, 'saveMercadoPagoSettings');
const productCollection = collection(db, 'products');
const STORAGE_KEYS = {
	cart: 'forno-brasa-cart',
	deliveryAddress: 'forno-brasa-delivery-address'
};

const initialProducts = [
	{ id: 'margherita', name: 'Margherita da casa', description: 'Tomate, mozzarella, manjericão fresco e azeite.', category: 'media', price: 42.9, image: '' },
	{ id: 'calabresa', name: 'Calabresa artesanal', description: 'Calabresa fatiada, cebola roxa e mozzarella.', category: 'grande', price: 54.9, image: '' },
	{ id: 'quatro-queijos', name: 'Quatro queijos', description: 'Mozzarella, provolone, parmesão e gorgonzola.', category: 'familia', price: 69.9, image: '' },
	{ id: 'pao-alho', name: 'Pão de alho', description: 'Pão tostado com alho, ervas e queijo.', category: 'petiscos', price: 18.9, image: '' },
	{ id: 'refrigerante', name: 'Refrigerante', description: 'Lata gelada de 350 ml.', category: 'bebidas', price: 7.9, image: '' }
];

// A leitura protegida evita que dados inválidos no armazenamento parem a página.
function readStorage(key, fallback) {
	try {
		const value = localStorage.getItem(key);
		return value ? JSON.parse(value) : fallback;
	} catch {
		return fallback;
	}
}

function saveStorage(key, value) {
	localStorage.setItem(key, JSON.stringify(value));
}

function populateDeliveryAddress(address) {
	deliveryForm.reset();
	if (address) {
		Object.entries(address).forEach(([field, value]) => {
			if (deliveryForm.elements[field]) deliveryForm.elements[field].value = value;
		});
	}
	postalCodeInput.dispatchEvent(new Event('input'));
	phoneInput.dispatchEvent(new Event('input'));
}

async function loadDeliveryAddress(user) {
	let address = null;
	if (user && getUserRole(user) === 'customer') {
		const profile = await getDoc(doc(db, 'profiles', user.uid));
		address = profile.data()?.deliveryAddress || null;
	} else if (!user) {
		address = readStorage(STORAGE_KEYS.deliveryAddress, null);
	}
	if (signedInUser?.uid !== user?.uid) return;
	populateDeliveryAddress(address);
}

let products = initialProducts;
let cart = readStorage(STORAGE_KEYS.cart, []);
let currentRole = 'customer';
let isRegistering = false;
let toastTimer;
let signedInUser = null;
let hasLoadedRemoteProducts = false;

const productGrid = document.querySelector('#product-grid');
const filters = [...document.querySelectorAll('.filter')];
const accountDialog = document.querySelector('#account-dialog');
const accountForm = document.querySelector('#account-form');
const accountContent = document.querySelector('#account-content');
const accountSession = document.querySelector('#account-session');
const accountMessage = document.querySelector('#account-message');
const productManager = document.querySelector('#product-manager');
const productForm = document.querySelector('#product-form');
const managerList = document.querySelector('#manager-list');
const mercadoPagoForm = document.querySelector('#mercado-pago-form');
const mercadoPagoStatus = document.querySelector('#mercado-pago-status');
const mercadoPagoMessage = document.querySelector('#mercado-pago-message');
const imageInput = productForm.elements.image;
const imagePreview = document.querySelector('#product-image-preview');
const deliveryForm = document.querySelector('#delivery-form');
const postalCodeInput = deliveryForm.elements.postalCode;
const phoneInput = deliveryForm.elements.phone;

function formatPrice(value) {
	return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function showToast(message) {
	const toast = document.querySelector('#toast');
	toast.textContent = message;
	toast.classList.add('show');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

async function refreshMercadoPagoStatus() {
	mercadoPagoStatus.textContent = 'Verificando configuração...';
	mercadoPagoStatus.dataset.state = 'loading';
	try {
		const result = await getMercadoPagoSettings();
		const settings = result.data;
		const accessToken = settings.accessTokenConfigured ? `Access Token configurado (${settings.environment}).` : 'Access Token não configurado.';
		const webhook = settings.webhookSecretConfigured ? 'Assinatura do webhook configurada.' : 'Assinatura do webhook não configurada.';
		mercadoPagoStatus.textContent = `${accessToken} ${webhook}`;
		mercadoPagoStatus.dataset.state = settings.accessTokenConfigured && settings.webhookSecretConfigured ? 'ready' : 'incomplete';
	} catch (error) {
		mercadoPagoStatus.textContent = 'Não foi possível consultar o Secret Manager. Confira a implantação e as permissões da função.';
		mercadoPagoStatus.dataset.state = 'error';
		console.error('Falha ao consultar as credenciais do Mercado Pago:', error);
	}
}

function selectManagerTab(tab) {
	const isMercadoPago = tab === 'mercado-pago';
	const productsTabButton = document.querySelector('#products-tab-button');
	const mercadoPagoTabButton = document.querySelector('#mercado-pago-tab-button');
	productsTabButton.setAttribute('aria-selected', String(!isMercadoPago));
	mercadoPagoTabButton.setAttribute('aria-selected', String(isMercadoPago));
	document.querySelector('#products-tab-panel').hidden = isMercadoPago;
	document.querySelector('#mercado-pago-tab-panel').hidden = !isMercadoPago;
	if (isMercadoPago) void refreshMercadoPagoStatus();
}

function renderProducts(category = 'todos') {
	const visibleProducts = products.filter(product => category === 'todos' || product.category === category);
	productGrid.replaceChildren();

	if (!visibleProducts.length) {
		const emptyMessage = document.createElement('p');
		emptyMessage.className = 'empty';
		emptyMessage.textContent = 'Nenhum produto nesta categoria por enquanto.';
		productGrid.append(emptyMessage);
		return;
	}

	visibleProducts.forEach(product => {
		const card = document.createElement('article');
		card.className = 'product-card';

		const visual = document.createElement('div');
		visual.className = 'product-image';
		if (product.image) {
			visual.style.backgroundImage = `url("${product.image}")`;
			visual.style.backgroundPosition = 'center';
			visual.style.backgroundSize = 'cover';
			visual.classList.add('has-product-photo');
		}

		const info = document.createElement('div');
		info.className = 'product-info';
		const heading = document.createElement('header');
		const title = document.createElement('h3');
		title.textContent = product.name;
		heading.append(title);
		const description = document.createElement('p');
		description.className = 'description';
		description.textContent = product.description;
		const footer = document.createElement('div');
		footer.className = 'product-footer';
		const price = document.createElement('p');
		price.className = 'price';
		price.textContent = formatPrice(product.price);
		const addButton = document.createElement('button');
		addButton.className = 'add-button';
		addButton.type = 'button';
		addButton.textContent = 'Adicionar';
		addButton.setAttribute('aria-label', `Adicionar ${product.name} à sacola`);
		addButton.addEventListener('click', () => addToCart(product.id));
		footer.append(price, addButton);
		info.append(heading, description, footer);
		card.append(visual, info);
		productGrid.append(card);
	});
}

function renderCart() {
	const cartItems = document.querySelector('#cart-items');
	const cartCount = document.querySelector('#cart-count');
	const totalElement = document.querySelector('#cart-total');
	const itemCount = cart.reduce((sum, item) => sum + item.quantity, 0);
	cartCount.textContent = itemCount;
	cartItems.replaceChildren();

	if (!cart.length) {
		const emptyMessage = document.createElement('p');
		emptyMessage.className = 'empty';
		emptyMessage.textContent = 'Sua sacola está vazia. Escolha uma pizza no cardápio.';
		cartItems.append(emptyMessage);
	} else {
		const list = document.createElement('ul');
		list.className = 'cart-list';
		cart.forEach(item => {
			const product = products.find(entry => entry.id === item.id);
			if (!product) return;
			const row = document.createElement('li');
			row.className = 'cart-item';
			const thumb = document.createElement('div');
			thumb.className = 'cart-thumb';
			if (product.image) thumb.style.background = `center / cover url("${product.image}")`;
			const details = document.createElement('div');
			details.className = 'cart-item-info';
			const name = document.createElement('strong');
			name.textContent = product.name;
			const itemPrice = document.createElement('p');
			itemPrice.className = 'cart-item-price';
			itemPrice.textContent = formatPrice(product.price * item.quantity);
			const controls = document.createElement('div');
			controls.className = 'quantity-controls';
			const decrease = document.createElement('button');
			decrease.type = 'button';
			decrease.textContent = '−';
			decrease.setAttribute('aria-label', `Remover uma unidade de ${product.name}`);
			decrease.addEventListener('click', () => changeQuantity(product.id, -1));
			const quantity = document.createElement('span');
			quantity.textContent = item.quantity;
			const increase = document.createElement('button');
			increase.type = 'button';
			increase.textContent = '+';
			increase.setAttribute('aria-label', `Adicionar uma unidade de ${product.name}`);
			increase.addEventListener('click', () => changeQuantity(product.id, 1));
			controls.append(decrease, quantity, increase);
			details.append(name, itemPrice, controls);
			row.append(thumb, details);
			list.append(row);
		});
		cartItems.append(list);
	}

	const total = cart.reduce((sum, item) => {
		const product = products.find(entry => entry.id === item.id);
		return sum + (product ? product.price * item.quantity : 0);
	}, 0);
	totalElement.textContent = formatPrice(total);
	saveStorage(STORAGE_KEYS.cart, cart);
}

function addToCart(productId) {
	const existingItem = cart.find(item => item.id === productId);
	if (existingItem) existingItem.quantity += 1;
	else cart.push({ id: productId, quantity: 1 });
	renderCart();
	showToast('Produto adicionado à sacola.');
}

function changeQuantity(productId, change) {
	const item = cart.find(entry => entry.id === productId);
	if (!item) return;
	item.quantity += change;
	if (item.quantity <= 0) cart = cart.filter(entry => entry.id !== productId);
	renderCart();
}

function setRole(role) {
	currentRole = role;
	isRegistering = false;
	document.querySelectorAll('.account-role').forEach(button => {
		const isActive = button.dataset.role === role;
		button.classList.toggle('active', isActive);
		button.setAttribute('aria-pressed', String(isActive));
	});
	document.querySelector('#account-title').textContent = role === 'owner' ? 'Acesso do proprietário' : 'Acesse sua conta';
	document.querySelector('#account-intro').textContent = role === 'owner'
		? 'Entre para cadastrar, editar ou remover produtos do cardápio.'
		: 'Clientes podem acompanhar pedidos, atualizar seus dados e consultar a sacola por aqui.';
	document.querySelector('#name-field').hidden = role === 'owner';
	accountForm.elements.name.required = false;
	document.querySelector('#account-switch').hidden = role === 'owner';
	document.querySelector('#account-demo').hidden = role !== 'owner';
	document.querySelector('#account-switch').textContent = 'Ainda não tem conta? Cadastre-se';
	accountMessage.textContent = '';
	accountForm.reset();
	accountForm.elements.password.autocomplete = 'current-password';
	accountForm.querySelector('.account-submit').firstChild.textContent = 'Entrar';
}

function showAccountSession(user) {
	accountContent.hidden = true;
	accountSession.hidden = false;
	const role = getUserRole(user);
	document.querySelector('#account-greeting').textContent = `Olá, ${user.displayName || user.email}`;
	document.querySelector('#account-session-copy').textContent = role === 'owner'
		? 'Seu acesso de proprietário está ativo. Gerencie os produtos e mantenha o cardápio atualizado.'
		: 'Sua conta de cliente está pronta. Você pode montar sua sacola e acompanhar as informações da loja.';
	document.querySelector('#open-owner-panel').hidden = role !== 'owner';
	document.querySelector('#account-action').textContent = user.displayName ? user.displayName.split(' ')[0] : 'Minha conta';
}

function resetAccountDialog() {
	accountContent.hidden = false;
	accountSession.hidden = true;
	productManager.hidden = true;
	accountDialog.classList.remove('owner-workspace-open');
	setRole(getUserRole(signedInUser));
	if (signedInUser) showAccountSession(signedInUser);
}

function getUserRole(user) {
	return user?.emailVerified && user.email?.toLowerCase() === OWNER_EMAIL ? 'owner' : 'customer';
}

function getAuthErrorMessage(error) {
	const messages = {
		'auth/email-already-in-use': 'Este e-mail já tem uma conta. Entre em vez de se cadastrar.',
		'auth/invalid-credential': 'E-mail ou senha incorretos.',
		'auth/invalid-email': 'Informe um e-mail válido.',
		'auth/operation-not-allowed': 'Ative E-mail/senha em Authentication > Sign-in method no Firebase Console.',
		'auth/too-many-requests': 'O Firebase limitou os envios. Aguarde e confira também Spam e Promoções.',
		'auth/unauthorized-continue-uri': 'Adicione localhost em Authentication > Settings > Authorized domains no Firebase Console.',
		'auth/invalid-continue-uri': 'O domínio usado para verificar o e-mail não está autorizado no Firebase.',
		'auth/network-request-failed': 'Falha de rede ao falar com o Firebase. Verifique sua conexão e tente novamente.',
		'auth/quota-exceeded': 'O limite de e-mails do Firebase foi atingido. Tente novamente mais tarde.',
		'auth/weak-password': 'A senha precisa ter pelo menos 6 caracteres.'
	};
	return messages[error.code] || 'Não foi possível acessar o Firebase. Confira sua conexão e as configurações do projeto.';
}

function watchProducts() {
	return onSnapshot(productCollection, snapshot => {
		if (!snapshot.empty || hasLoadedRemoteProducts) {
			products = snapshot.docs.map(productDoc => ({ id: productDoc.id, ...productDoc.data() }));
		}
		hasLoadedRemoteProducts = true;
		renderProducts(document.querySelector('.filter.active')?.dataset.category || 'todos');
		if (!productManager.hidden) renderManagerList();
	}, error => {
		console.error('Falha ao carregar produtos do Firestore:', error);
		showToast('Não foi possível carregar o catálogo do Firebase. Verifique as regras do Firestore.');
	});
}

async function seedInitialProducts() {
	const snapshot = await getDocs(productCollection);
	if (!snapshot.empty) return;
	const batch = writeBatch(db);
	initialProducts.forEach(product => batch.set(doc(db, 'products', product.id), product));
	await batch.commit();
}

function renderManagerList() {
	managerList.replaceChildren();
	if (!products.length) {
		const emptyMessage = document.createElement('p');
		emptyMessage.className = 'empty';
		emptyMessage.textContent = 'Ainda não há produtos cadastrados.';
		managerList.append(emptyMessage);
		return;
	}

	products.forEach(product => {
		const row = document.createElement('article');
		row.className = 'manager-item';
		const itemInfo = document.createElement('div');
		const name = document.createElement('strong');
		name.textContent = product.name;
		const price = document.createElement('span');
		price.textContent = formatPrice(product.price);
		itemInfo.append(name, price);
		const actions = document.createElement('div');
		actions.className = 'manager-item-actions';
		const editButton = document.createElement('button');
		editButton.type = 'button';
		editButton.className = 'secondary-button';
		editButton.textContent = 'Editar';
		editButton.addEventListener('click', () => editProduct(product.id));
		const deleteButton = document.createElement('button');
		deleteButton.type = 'button';
		deleteButton.className = 'manager-delete';
		deleteButton.textContent = 'Excluir';
		deleteButton.addEventListener('click', () => deleteProduct(product.id));
		actions.append(editButton, deleteButton);
		row.append(itemInfo, actions);
		managerList.append(row);
	});
}

function resetProductForm() {
	productForm.reset();
	productForm.elements.productId.value = '';
	imageInput.required = true;
	imagePreview.hidden = true;
	imagePreview.removeAttribute('src');
	document.querySelector('#save-product').textContent = 'Cadastrar produto';
}

function editProduct(productId) {
	const product = products.find(entry => entry.id === productId);
	if (!product) return;
	productForm.elements.productId.value = product.id;
	productForm.elements.name.value = product.name;
	productForm.elements.description.value = product.description;
	productForm.elements.category.value = product.category;
	productForm.elements.price.value = product.price;
	imageInput.required = false;
	imagePreview.hidden = !product.image;
	if (product.image) imagePreview.src = product.image;
	document.querySelector('#save-product').textContent = 'Salvar alterações';
	productForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function deleteProduct(productId) {
	try {
		await deleteDoc(doc(db, 'products', productId));
		cart = cart.filter(item => item.id !== productId);
		renderCart();
		showToast('Produto removido do cardápio.');
	} catch (error) {
		console.error('Falha ao excluir produto:', error);
		showToast('Não foi possível excluir. Confirme que sua conta é a proprietária autorizada.');
	}
}

function readPng(file) {
	return new Promise((resolve, reject) => {
		if (!file || file.type !== 'image/png' || !file.name.toLowerCase().endsWith('.png')) {
			reject(new Error('Selecione um arquivo PNG válido.'));
			return;
		}
		if (file.size > 450 * 1024) {
			reject(new Error('No modo Firestore, a imagem PNG deve ter no máximo 450 KB.'));
			return;
		}
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
		reader.readAsDataURL(file);
	});
}

filters.forEach(button => button.addEventListener('click', () => {
	filters.forEach(filter => {
		const active = filter === button;
		filter.classList.toggle('active', active);
		filter.setAttribute('aria-pressed', String(active));
	});
	renderProducts(button.dataset.category);
}));

document.querySelector('#account-action').addEventListener('click', () => {
	resetAccountDialog();
	accountDialog.showModal();
});
document.querySelector('#close-account').addEventListener('click', () => accountDialog.close());
accountDialog.addEventListener('click', event => {
	if (event.target === accountDialog) accountDialog.close();
});
document.querySelectorAll('.account-role').forEach(button => button.addEventListener('click', () => setRole(button.dataset.role)));

document.querySelector('#account-switch').addEventListener('click', event => {
	isRegistering = !isRegistering;
	document.querySelector('#name-field').hidden = !isRegistering;
	accountForm.elements.name.required = isRegistering;
	accountForm.elements.password.autocomplete = isRegistering ? 'new-password' : 'current-password';
	document.querySelector('#account-intro').textContent = isRegistering
		? 'Crie sua conta para acessar as informações e novidades da Forno & Brasa.'
		: 'Clientes podem acompanhar pedidos, atualizar seus dados e consultar a sacola por aqui.';
	document.querySelector('#account-switch').textContent = isRegistering ? 'Já tem conta? Entrar' : 'Ainda não tem conta? Cadastre-se';
	accountForm.querySelector('.account-submit').firstChild.textContent = isRegistering ? 'Criar conta' : 'Entrar';
	accountMessage.textContent = '';
});

accountForm.addEventListener('submit', event => {
	event.preventDefault();
	void (async () => {
		const formData = new FormData(accountForm);
		const email = String(formData.get('email')).trim().toLowerCase();
		const password = String(formData.get('password'));
		const submitButton = accountForm.querySelector('.account-submit');
		submitButton.disabled = true;
		accountMessage.textContent = '';
		document.querySelector('#resend-verification').hidden = true;
		try {
			if (currentRole === 'owner') {
				if (email !== OWNER_EMAIL) throw new Error('E-mail ou senha incorretos.');
				const credential = await signInWithEmailAndPassword(auth, email, password);
				if (!credential.user.emailVerified) {
					document.querySelector('#resend-verification').hidden = false;
					await sendEmailVerification(credential.user);
					accountMessage.textContent = 'Link enviado. Confira a caixa de entrada, Spam e Promoções.';
					await signOut(auth);
					return;
				}
				showAccountSession(credential.user);
			} else if (isRegistering) {
				const displayName = String(formData.get('name')).trim();
				const credential = await createUserWithEmailAndPassword(auth, email, password);
				await updateProfile(credential.user, { displayName });
				await sendEmailVerification(credential.user);
				await setDoc(doc(db, 'profiles', credential.user.uid), {
					email,
					displayName,
					createdAt: new Date().toISOString()
				});
				showAccountSession(credential.user);
				document.querySelector('#account-session-copy').textContent = 'Conta criada. Enviamos um link de verificação para seu e-mail.';
			} else {
				const credential = await signInWithEmailAndPassword(auth, email, password);
				showAccountSession(credential.user);
			}
		} catch (error) {
			accountMessage.textContent = error.code?.startsWith('auth/') ? getAuthErrorMessage(error) : error.message;
		} finally {
			submitButton.disabled = false;
		}
	})();
});

document.querySelector('#resend-verification').addEventListener('click', async event => {
	const button = event.currentTarget;
	const email = accountForm.elements.email.value.trim().toLowerCase();
	const password = accountForm.elements.password.value;
	if (email !== OWNER_EMAIL || !password) {
		accountMessage.textContent = 'Informe o e-mail e a senha da conta proprietária para reenviar o link.';
		return;
	}
	button.disabled = true;
	try {
		const credential = await signInWithEmailAndPassword(auth, email, password);
		if (credential.user.emailVerified) {
			await signOut(auth);
			accountMessage.textContent = 'Este e-mail já está verificado. Entre novamente para abrir o painel.';
			button.hidden = true;
			return;
		}
		await sendEmailVerification(credential.user);
		await signOut(auth);
		accountMessage.textContent = 'Novo link enviado. Confira a caixa de entrada, Spam e Promoções.';
	} catch (error) {
		accountMessage.textContent = error.code?.startsWith('auth/') ? getAuthErrorMessage(error) : error.message;
	} finally {
		button.disabled = false;
	}
});

document.querySelector('#open-owner-panel').addEventListener('click', () => {
	if (getUserRole(signedInUser) !== 'owner') {
		showToast('Entre com o e-mail proprietário verificado para gerenciar produtos.');
		return;
	}
	void seedInitialProducts().then(() => {
		renderManagerList();
		selectManagerTab('products');
		accountSession.hidden = true;
		productManager.hidden = false;
		accountDialog.classList.add('owner-workspace-open');
		accountDialog.showModal();
	}).catch(error => {
		console.error('Falha ao inicializar o catálogo:', error);
		showToast('Não foi possível abrir o catálogo do Firebase. Verifique as regras do Firestore.');
	});
});
document.querySelector('#products-tab-button').addEventListener('click', () => selectManagerTab('products'));
document.querySelector('#mercado-pago-tab-button').addEventListener('click', () => selectManagerTab('mercado-pago'));
document.querySelector('#account-logout').addEventListener('click', async () => {
	await signOut(auth);
	document.querySelector('#account-action').textContent = 'Entrar';
	resetAccountDialog();
});

document.querySelector('#close-manager').addEventListener('click', () => {
	mercadoPagoForm.reset();
	mercadoPagoMessage.textContent = '';
	productManager.hidden = true;
	accountSession.hidden = false;
	accountDialog.classList.remove('owner-workspace-open');
});
mercadoPagoForm.addEventListener('submit', async event => {
	event.preventDefault();
	const accessToken = mercadoPagoForm.elements.accessToken.value.trim();
	const webhookSecret = mercadoPagoForm.elements.webhookSecret.value.trim();
	const submitButton = document.querySelector('#save-mercado-pago');
	mercadoPagoForm.reset();
	submitButton.disabled = true;
	mercadoPagoMessage.textContent = 'Salvando no Secret Manager...';
	try {
		await saveMercadoPagoSettingsCall({ accessToken, webhookSecret });
		mercadoPagoMessage.textContent = 'Credenciais salvas. Os valores não serão exibidos novamente.';
		await refreshMercadoPagoStatus();
	} catch (error) {
		mercadoPagoMessage.textContent = error.message || 'Não foi possível salvar as credenciais.';
	} finally {
		submitButton.disabled = false;
	}
});
document.querySelector('#new-product').addEventListener('click', resetProductForm);
imageInput.addEventListener('change', async () => {
	if (!imageInput.files[0]) return;
	try {
		imagePreview.src = await readPng(imageInput.files[0]);
		imagePreview.hidden = false;
	} catch (error) {
		imageInput.value = '';
		imagePreview.hidden = true;
		showToast(error.message);
	}
});

productForm.addEventListener('submit', async event => {
	event.preventDefault();
	const formData = new FormData(productForm);
	const productId = String(formData.get('productId'));
	const existingProduct = products.find(product => product.id === productId);
	let image = existingProduct?.image || '';
	try {
		if (imageInput.files[0]) image = await readPng(imageInput.files[0]);
		if (!image) throw new Error('Escolha uma imagem PNG para o produto.');
		const product = {
			id: existingProduct?.id || `produto-${Date.now()}`,
			name: String(formData.get('name')).trim(),
			description: String(formData.get('description')).trim(),
			category: String(formData.get('category')),
			price: Number(formData.get('price')),
			image
		};
		if (!Number.isFinite(product.price) || product.price <= 0) throw new Error('Informe um preço válido.');
		if (getUserRole(auth.currentUser) !== 'owner') throw new Error('Apenas a conta proprietária verificada pode salvar produtos.');
		await setDoc(doc(db, 'products', product.id), product);
		resetProductForm();
		showToast(existingProduct ? 'Produto atualizado.' : 'Produto cadastrado.');
	} catch (error) {
		showToast(error.message || 'Não foi possível salvar. O armazenamento local pode estar cheio.');
	}
});

const cartDrawer = document.querySelector('#cart-drawer');
function setCartOpen(open) {
	cartDrawer.classList.toggle('open', open);
	cartDrawer.setAttribute('aria-hidden', String(!open));
	document.querySelector('#overlay').setAttribute('aria-hidden', String(!open));
	document.body.classList.toggle('cart-open', open);
}
document.querySelector('#open-cart').addEventListener('click', () => setCartOpen(true));
document.querySelector('#close-cart').addEventListener('click', () => setCartOpen(false));
document.querySelector('#overlay').addEventListener('click', () => setCartOpen(false));
document.addEventListener('keydown', event => {
	if (event.key === 'Escape') setCartOpen(false);
});

function formatPostalCode(value) {
	const digits = value.replace(/\D/g, '').slice(0, 8);
	return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

function formatPhone(value) {
	const digits = value.replace(/\D/g, '').slice(0, 11);
	if (!digits) return '';
	if (digits.length <= 2) return `(${digits}`;
	const areaCode = digits.slice(0, 2);
	const subscriber = digits.slice(2);
	const splitAt = subscriber.length > 8 ? 5 : 4;
	const formattedSubscriber = subscriber.length > 4
		? `${subscriber.slice(0, splitAt)}-${subscriber.slice(splitAt)}`
		: subscriber;
	return `(${areaCode}) ${formattedSubscriber}`;
}

async function lookupPostalCode(value) {
	const digits = value.replace(/\D/g, '');
	if (digits.length !== 8) throw new Error('CEP: Digite um CEP válido com 8 números.');
	const response = await fetch(`https://viacep.com.br/ws/${digits}/json/`);
	if (!response.ok) throw new Error('CEP: Não foi possível consultar o CEP. Tente novamente.');
	const result = await response.json();
	if (result.erro) throw new Error('CEP: Este CEP não foi encontrado. Confira os números.');
	return result;
}

function isWithinDeliveryArea(postalCodeInfo) {
	return postalCodeInfo.uf === 'AL'
		&& postalCodeInfo.localidade?.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() === 'japaratinga';
}

postalCodeInput.addEventListener('input', () => {
	postalCodeInput.value = formatPostalCode(postalCodeInput.value);
	document.querySelector('#checkout-message').textContent = '';
});
phoneInput.addEventListener('input', () => {
	phoneInput.value = formatPhone(phoneInput.value);
});
postalCodeInput.addEventListener('blur', async () => {
	if (postalCodeInput.value.replace(/\D/g, '').length !== 8) return;
	const message = document.querySelector('#checkout-message');
	message.textContent = 'Consultando CEP...';
	try {
		const result = await lookupPostalCode(postalCodeInput.value);
		if (!isWithinDeliveryArea(result)) {
			message.textContent = 'Entregamos somente em Japaratinga, Alagoas.';
			return;
		}
		if (result.logradouro) deliveryForm.elements.street.value = result.logradouro;
		if (result.bairro) deliveryForm.elements.neighborhood.value = result.bairro;
		if (result.localidade) deliveryForm.elements.city.value = result.localidade;
		message.textContent = 'CEP localizado. Confira o endereço e informe o número.';
	} catch (error) {
		message.textContent = error.message.startsWith('CEP:')
			? error.message.slice(5).trim()
			: 'Não foi possível consultar o CEP. Verifique sua conexão e tente novamente.';
	}
});

deliveryForm.addEventListener('submit', async event => {
	event.preventDefault();
	const message = document.querySelector('#checkout-message');
	if (!cart.length) {
		message.textContent = 'Adicione pelo menos um produto à sacola antes de continuar.';
		return;
	}
	const address = Object.fromEntries(new FormData(deliveryForm).entries());
	try {
		const postalCodeInfo = await lookupPostalCode(address.postalCode);
		if (!isWithinDeliveryArea(postalCodeInfo)) {
			message.textContent = 'Entregamos somente em Japaratinga, Alagoas.';
			return;
		}
		if (postalCodeInfo.logradouro) address.street = postalCodeInfo.logradouro;
		if (postalCodeInfo.bairro) address.neighborhood = postalCodeInfo.bairro;
		if (postalCodeInfo.localidade) address.city = postalCodeInfo.localidade;
		for (const field of ['street', 'neighborhood', 'city']) {
			deliveryForm.elements[field].value = address[field];
		}
	} catch (error) {
		message.textContent = error.message.startsWith('CEP:')
			? error.message.slice(5).trim()
			: 'Não foi possível consultar o CEP. Verifique sua conexão e tente novamente.';
		return;
	}
	try {
		if (signedInUser && getUserRole(signedInUser) === 'customer') {
			await setDoc(doc(db, 'profiles', signedInUser.uid), { deliveryAddress: address }, { merge: true });
		} else {
			saveStorage(STORAGE_KEYS.deliveryAddress, address);
		}
		const items = cart.map(item => {
			const product = products.find(entry => entry.id === item.id);
			if (!product) throw new Error('Um produto da sacola não está mais disponível. Atualize a página.');
			return {
				id: product.id,
				name: product.name,
				quantity: item.quantity,
				unitPrice: product.price
			};
		});
		const total = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
		const order = await addDoc(collection(db, 'orders'), {
			customer: {
				name: signedInUser?.displayName || 'Cliente',
				...(signedInUser ? { userId: signedInUser.uid } : {}),
				phone: address.phone,
				address: {
					street: address.street,
					number: address.number,
					postalCode: address.postalCode,
					neighborhood: address.neighborhood,
					city: address.city,
					complement: address.complement
				}
			},
			items,
			total,
			status: 'novo',
			createdAt: new Date().toISOString()
		});
		const preferenceResult = await createMercadoPagoPreference({
			orderId: order.id,
			siteOrigin: window.location.origin
		});
		const checkoutUrl = preferenceResult.data?.initPoint;
		if (typeof checkoutUrl !== 'string' || !checkoutUrl.startsWith('https://')) {
			throw new Error('O Mercado Pago não retornou um link de pagamento válido.');
		}
		cart = [];
		renderCart();
		deliveryForm.reset();
		message.textContent = 'Pedido registrado. Redirecionando para o Mercado Pago...';
		window.location.assign(checkoutUrl);
	} catch (error) {
		console.error('Falha ao enviar pedido:', error);
		message.textContent = error.code?.startsWith('functions/')
			? error.message
			: 'Não foi possível registrar o pedido ou iniciar o pagamento. Verifique sua conexão e tente novamente.';
	}
});


onAuthStateChanged(auth, user => {
	signedInUser = user;
	document.querySelector('#account-action').textContent = user?.displayName?.split(' ')[0] || (user ? 'Minha conta' : 'Entrar');
	void loadDeliveryAddress(user).catch(error => {
		console.error('Falha ao carregar o endereço de entrega:', error);
		showToast('Não foi possível carregar o endereço salvo desta conta.');
	});
});
watchProducts();
renderProducts();
renderCart();
resetAccountDialog();
const paymentReturn = new URLSearchParams(window.location.search).get('payment');
const paymentReturnMessages = {
	success: 'Retorno recebido do Mercado Pago. A confirmação do pagamento está sendo atualizada.',
	pending: 'Pagamento em análise no Mercado Pago.',
	failure: 'Pagamento não concluído. Você pode iniciar uma nova tentativa.'
};
if (paymentReturnMessages[paymentReturn]) {
	showToast(paymentReturnMessages[paymentReturn]);
	const returnUrl = new URL(window.location.href);
	returnUrl.searchParams.delete('payment');
	returnUrl.searchParams.delete('order');
	history.replaceState(null, '', returnUrl);
}
