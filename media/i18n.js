// Interface translation for the webviews. English is the source language; a dictionary
// replaces exact texts (and tooltips) after they are rendered. Chat messages are never touched.
(function () {
  const lang = (window.__LANG || 'en').toLowerCase().startsWith('uk') ? 'uk' : 'en';
  if (lang === 'en') {
    window.i18n = { lang, translate() {} };
    return;
  }

  const UK = {
    // sidebar: banner, tabs, notices
    'Active model': 'Активна модель',
    'Open chat': 'Відкрити чат',
    'This computer': 'Цей комп\'ютер',
    'Cloud': 'Хмара',
    'Settings (local and cloud)': 'Налаштування (локальні та хмарні)',
    'No model selected. Pick one in the This computer or Cloud tab below.': 'Модель не вибрано. Оберіть її нижче у вкладці «Цей комп\'ютер» або «Хмара».',
    'Nothing leaves this computer.': 'Нічого не залишає цей комп\'ютер.',
    'Runs on this computer. Nothing leaves it.': 'Працює на цьому комп\'ютері. Нічого не виходить назовні.',
    'Models that run on this computer through Ollama. Private and free, no internet needed.': 'Моделі, що працюють на цьому комп\'ютері через Ollama. Приватно, безкоштовно, інтернет не потрібен.',
    'Models that run online at a provider with its own free tier. They are stronger but your messages leave this computer, and free limits apply.': 'Моделі, що працюють онлайн у провайдера з безкоштовним тарифом. Вони сильніші, але ваші повідомлення залишають комп\'ютер, і діють безкоштовні ліміти.',
    'Installed': 'Встановлені',
    'Other installed': 'Інші встановлені',
    'No model installed yet. Open "Get more models" below.': 'Жодної моделі ще не встановлено. Відкрийте «Більше моделей» нижче.',
    'Get more models': 'Більше моделей',
    'Install a model by name...': 'Встановити модель за назвою...',
    'Everything in this category is already installed.': 'Усе з цієї категорії вже встановлено.',
    'How to uninstall Ollama': 'Як видалити Ollama',
    'Code': 'Код',
    'General': 'Загальні',
    'Vision': 'Зображення',
    'Install': 'Встановити',
    'Use': 'Обрати',
    'Active': 'Активна',
    'Cancel': 'Скасувати',
    'Start Ollama': 'Запустити Ollama',
    'Check again': 'Перевірити ще раз',
    'Install automatically': 'Встановити автоматично',
    'Download from website': 'Завантажити з сайту',
    'I installed it, check again': 'Я встановив, перевірити ще раз',
    'Ollama is installed but not running.': 'Ollama встановлена, але не запущена.',
    'Ollama is not installed.': 'Ollama не встановлена.',
    'It runs the models on this computer. Not needed if you only use cloud models.': 'Вона запускає моделі на цьому комп\'ютері. Не потрібна, якщо ви користуєтесь лише хмарними моделями.',
    'How should the AI run?': 'Де запускати ШІ?',
    'On this computer': 'На цьому комп\'ютері',
    'In the cloud': 'У хмарі',
    'Private and free, works offline. Needs Ollama and a few GB of disk; speed depends on your computer.': 'Приватно й безкоштовно, працює без інтернету. Потрібна Ollama і кілька ГБ на диску; швидкість залежить від комп\'ютера.',
    'Faster and stronger, with a free API key (Groq, Gemini and others). Your messages and the files it reads are sent to the provider.': 'Швидше й сильніше, з безкоштовним API-ключем (Groq, Gemini та інші). Ваші повідомлення й файли, які читає модель, надсилаються провайдеру.',
    'Connect a free provider': 'Підключити безкоштовного провайдера',
    'Choose a model': 'Обрати модель',
    'Install Ollama': 'Встановити Ollama',
    'You can use both and switch any time.': 'Можна користуватися обома й перемикатися будь-коли.',
    'Show all options': 'Показати всі параметри',
    'Checked by a reviewer agent: the changes look correct.': 'Перевірено агентом-рецензентом: зміни виглядають правильними.',
    'Quick check passed: no syntax errors or broken links.': 'Швидка перевірка пройдена: немає синтаксичних помилок і зламаних зв\'язків.',
    // sidebar: settings
    'Both': 'Обидва',
    'Local': 'Локальні',
    'Help': 'Допомога',
    'work with any model': 'працюють з будь-якою моделлю',
    'only models on this computer': 'лише моделі на цьому комп\'ютері',
    'only online models': 'лише онлайн-моделі',
    'something wrong?': 'щось не так?',
    'System prompt': 'Системна підказка',
    'Response mode': 'Режим відповіді',
    'Work mode': 'Режим роботи',
    'fast': 'швидкий',
    'standard': 'стандарт',
    'agent': 'агент',
    'Fast': 'Швидкий',
    'Standard': 'Стандартний',
    'Agent': 'Агентний',
    'Thinking': 'Роздуми',
    'Model default': 'Як у моделі',
    'Auto (small models answer directly)': 'Авто (малі моделі відповідають без роздумів)',
    'Fast (little thinking)': 'Швидко (мало роздумів)',
    'Deep (think longer)': 'Глибоко (думати довше)',
    'Send active file as context': 'Надсилати активний файл як контекст',
    'Helper agents model': 'Модель для помічників',
    'Folder access': 'Доступ до папок',
    'Claude skills': 'Навички Claude',
    'Voice input': 'Голосовий ввід',
    'Context length': 'Довжина контексту',
    'Run on': 'Запускати на',
    'Keep model in RAM': 'Тримати модель у пам\'яті',
    'Cloud context size': 'Розмір контексту для хмари',
    'Copy diagnostics for a bug report': 'Скопіювати діагностику для звіту про помилку',
    'no keys or chats': 'без ключів і чатів',
    'Speech recognition': 'Розпізнавання мови',
    'On': 'Увімк.',
    'Off': 'Вимк.',
    'none': 'немає',
    'Same as chat': 'Як у чаті',
    // sidebar: cloud
    'Cloud models (free)': 'Хмарні моделі (безкоштовні)',
    'Cloud models': 'Хмарні моделі',
    'Providers': 'Провайдери',
    'Add cloud models...': 'Додати хмарні моделі...',
    'Connect a cloud provider...': 'Підключити хмарного провайдера...',
    'connected': 'підключено',
    'Change models': 'Змінити моделі',
    'Choose models': 'Обрати моделі',
    'Change key': 'Змінити ключ',
    'API key': 'API-ключ',
    'Get API key': 'Отримати API-ключ',
    'Image generation': 'Генерація картинок',
    'Code completion': 'Автодоповнення коду',
    'Meaning search': 'Пошук за змістом',
    'Reviewer model': 'Модель-рецензент',
    'Usage statistics': 'Статистика використання',
    'Show...': 'Показати...',
    'MCP servers': 'MCP-сервери',
    'Manage...': 'Керувати...',
    'search model': 'модель пошуку',
    'Switch model when a limit is hit': 'Змінювати модель при ліміті',
    'paid': 'платний',
    'Add': 'Додати',
    'Sign in to Ollama...': 'Увійти в Ollama...',
    'Very large models that run on ollama.com through your Ollama, with no API key: sign in once with a free account. The free plan has a monthly allowance and runs one request at a time.': 'Дуже великі моделі, які працюють на ollama.com через вашу Ollama без API-ключа: достатньо один раз увійти з безкоштовним акаунтом. Безкоштовний план має місячний ліміт і виконує один запит за раз.',
    'Runs on ollama.com: your prompts leave this computer': 'Працює на ollama.com: ваші запити залишають цей комп\'ютер',
    'Remove from the model list': 'Прибрати зі списку моделей',
    'this computer': 'цей комп\'ютер',
    'server': 'сервер',
    'Check limits': 'Перевірити ліміти',
    'Connect': 'Підключити',
    'Connect with API key': 'Підключити за API-ключем',
    'Get free key': 'Отримати безкоштовний ключ',
    'Get a free key': 'Отримати безкоштовний ключ',
    'Remaining quota appears here after your first answer.': 'Залишок квоти з\'явиться тут після першої відповіді.',
    'agent-ready': 'годиться для агента',
    'weak for agent': 'слабка для агента',
    'basic agent': 'базовий агент',
    'no tools': 'без інструментів',
    'tiny free limit': 'замалий безкоштовний ліміт',
    'vision': 'бачить зображення',
    // chat
    'What are we building?': 'Що будуємо?',
    'New chat': 'Новий чат',
    'Ask anything about your project...': 'Запитайте будь-що про ваш проєкт...',
    'Attach a file': 'Прикріпити файл',
    'Text or code file as context': 'Текстовий файл або код як контекст',
    'Attach an image': 'Прикріпити зображення',
    'Git changes': 'Зміни в git',
    'Everything not committed yet, as a diff': 'Усе, що ще не закомічено, у вигляді diff',
    'Problems': 'Проблеми',
    'Errors and warnings from the Problems panel': 'Помилки й попередження з панелі Problems',
    'Ask before edits': 'Питати перед змінами',
    'Edit automatically': 'Змінювати автоматично',
    'Read only': 'Лише читання',
    'Autopilot': 'Автопілот',
    'Every edit and command needs your approval': 'Кожна зміна й команда потребує вашого дозволу',
    'Edits are applied right away, commands still ask': 'Зміни застосовуються одразу, команди все одно питають',
    'The AI can look at files but changes nothing': 'ШІ може дивитись файли, але нічого не змінює',
    'Thinking': 'Думає',
    'Writing': 'Пише',
    'Working on your project': 'Працює над проєктом',
    'Yes': 'Так',
    'No': 'Ні',
    'Undo all changes': 'Скасувати всі зміни',
    'Try another model:': 'Спробувати іншу модель:',
    'Show all': 'Показати все',
    'Open file': 'Відкрити файл',
    'Open diff': 'Відкрити diff',
    'Search chats...': 'Шукати чати...',
    'Switch chat': 'Перемкнути чат',
    'Project access': 'Доступ до проєкту',
    'Attach files': 'Прикріпити файли',
    'Change model': 'Змінити модель',
    'Voice input': 'Голосовий ввід',
    'Stop generating': 'Зупинити генерацію',
    'Send': 'Надіслати',
    'Copy text': 'Копіювати текст',
    'Edit': 'Редагувати',
    'Delete chat': 'Видалити чат',
    'What the AI may do without asking': 'Що ШІ може робити без запитання',
    'Skills (type / in the box)': 'Навички (введіть / у полі)',
    'Helper agents and tokens': 'Помічники й токени',
    'Free-tier limits of the cloud provider': 'Безкоштовні ліміти хмарного провайдера'
  };

  const RULES = [
    [/^Install (.+) \((.+)\)$/, (m) => 'Встановити ' + m[1] + ' (' + m[2] + ')'],
    [/^The check found problems, fixing them \(round (\d) of (\d)\)\.\.\.$/, (m) => 'Перевірка знайшла проблеми, виправляю (раунд ' + m[1] + ' з ' + m[2] + ')...'],
    [/^(Thinking|Writing|Working on your project)( · (\d+)s)?$/, (m) => ({ Thinking: 'Думає', Writing: 'Пише', 'Working on your project': 'Працює над проєктом' }[m[1]]) + (m[3] ? ' · ' + m[3] + 'с' : '')],
    [/^(\d+) files? changed( \((\d+) new\))?$/, (m) => m[1] + ' ' + (m[1] === '1' ? 'файл змінено' : 'файлів змінено') + (m[3] ? ' (' + m[3] + ' нових)' : '')],
    [/^Free-tier limits of (.+)$/, (m) => 'Безкоштовні ліміти ' + m[1]],
    [/^Installed on this computer$/, () => 'Встановлені на цьому комп\'ютері'],
    [/^(\d+) installed$/, (m) => m[1] + ' встановлено'],
    [/^(\d+) added$/, (m) => m[1] + ' додано'],
    [/^off$/, () => 'вимк.'],
    [/^Add another provider \((\d+)\)$/, (m) => 'Додати іншого провайдера (' + m[1] + ')'],
    [/^Your messages are sent to (.+)\. Free-tier limits apply\.$/, (m) => 'Ваші повідомлення надсилаються до ' + m[1] + '. Діють безкоштовні ліміти.'],
    [/^Online\. Your messages and the files it reads are sent to (.+)\.$/, (m) => 'Онлайн. Ваші повідомлення та файли, які модель читає, надсилаються до ' + m[1] + '.'],
    [/^Your computer: (.+)\. Comfortable model files: up to about (.+) GB\.$/, (m) => 'Ваш комп\'ютер: ' + m[1] + '. Комфортний розмір моделі: до ~' + m[2] + ' ГБ.']
  ];

  const ATTRS = ['title', 'placeholder'];
  const SKIP = 'pre, code, textarea, input, .row.user .bubble, .row.assistant .bubble, [data-no-i18n]';

  function tr(text) {
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (UK[trimmed] !== undefined) return text.replace(trimmed, UK[trimmed]);
    for (const [re, fn] of RULES) {
      const m = trimmed.match(re);
      if (m) return text.replace(trimmed, fn(m));
    }
    return null;
  }

  function translate(root) {
    if (!root) return;
    const base = root.nodeType === 3 ? root.parentElement : root;
    if (base && base.closest && base.closest(SKIP)) return;
    if (root.nodeType === 3) {
      const t = tr(root.nodeValue);
      if (t !== null && t !== root.nodeValue) root.nodeValue = t;
      return;
    }
    if (root.nodeType !== 1) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((n) => {
      if (n.parentElement && n.parentElement.closest(SKIP)) return;
      const t = tr(n.nodeValue);
      if (t !== null && t !== n.nodeValue) n.nodeValue = t;
    });
    const withAttrs = [root, ...root.querySelectorAll('[title], [placeholder]')];
    withAttrs.forEach((el) => {
      if (el.closest && el.closest('pre, code, .row.user .bubble, .row.assistant .bubble')) return;
      ATTRS.forEach((a) => {
        const v = el.getAttribute && el.getAttribute(a);
        if (!v) return;
        const t = tr(v);
        if (t !== null && t !== v) el.setAttribute(a, t);
      });
    });
  }

  let busy = false;
  const observer = new MutationObserver((mutations) => {
    if (busy) return;
    busy = true;
    try {
      mutations.forEach((m) => {
        if (m.type === 'childList') m.addedNodes.forEach((n) => translate(n));
        else if (m.type === 'characterData') translate(m.target);
      });
    } finally {
      busy = false;
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    translate(document.body);
  });
  window.i18n = { lang, translate };
})();
