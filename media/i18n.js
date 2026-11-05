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


  // Texts of the reworked chat and sidebar, the steps, the plan and the dialogs.
  Object.assign(UK, {
    'Asks': 'Питає',
    'Edits': 'Змінює',
    'Reads': 'Читає',
    'Always in this chat': 'Завжди в цьому чаті',
    'Something else...': 'Інше...',
    'Apply this change?': 'Застосувати зміну?',
    'Create this file?': 'Створити цей файл?',
    'Run this command?': 'Виконати команду?',
    'Read this web page?': 'Прочитати цю сторінку?',
    'Use the MCP tool': 'Використати інструмент MCP',
    'Or type your own answer': 'Або напишіть свою відповідь',
    'Tell the AI what to do instead': 'Напишіть, що зробити замість цього',
    "Yes, and don't ask again for edits in this chat": 'Так, і не питати про зміни в цьому чаті',
    "Yes, and don't ask again for commands in this chat": 'Так, і не питати про команди в цьому чаті',
    "Yes, and don't ask again for this server in this chat": 'Так, і не питати про цей сервер у цьому чаті',
    "Yes, and don't ask again for web pages in this chat": 'Так, і не питати про вебсторінки в цьому чаті',
    'Esc': 'Esc',
    'I work in': 'Я працюю в',
    ': I create and edit files myself and ask before changes. The chat is for talking and corrections.': ': сам створюю й змінюю файли та питаю перед змінами. Чат — для розмови й правок.',
    'Project access is': 'Доступ до проєкту',
    'off': 'вимкнено',
    ', so I can only chat. Click the folder button above to let me create and edit files in': ', тож я можу лише спілкуватися. Натисніть кнопку теки вгорі, щоб дозволити мені створювати й змінювати файли в',
    ': code goes into files, the chat is for talking and corrections. This small model cannot read your project on its own, so name the files you want changed. A': ': код іде у файли, чат — для розмови й правок. Ця мала модель сама не читає проєкт, тож називайте файли, які треба змінити. Модель із',
    'model (e.g. Qwen2.5 Coder 7B) does it better.': '(наприклад, Qwen2.5 Coder 7B) робить це краще.',
    'The model': 'Модель',
    'cannot use tools here. Pick a model tagged': 'тут не вміє користуватися інструментами. Виберіть модель із позначкою',
    '(e.g. Qwen2.5 Coder 7B) to work with': '(наприклад, Qwen2.5 Coder 7B), щоб працювати з',
    'Plan': 'План',
    'Must work': 'Має працювати',
    'Created': 'Створено',
    'Edited': 'Змінено',
    'Updated': 'Оновлено',
    'Creating': 'Створюю',
    'Editing': 'Змінюю',
    'Updating': 'Оновлюю',
    'Reading': 'Читаю',
    'Read': 'Прочитано',
    'Listing': 'Переглядаю',
    'Listed': 'Переглянуто',
    'Searching': 'Шукаю',
    'Searched': 'Знайдено',
    'Running': 'Виконую',
    'Ran': 'Виконано',
    'Drawing': 'Малюю',
    'Drew': 'Намальовано',
    'Checking problems': 'Перевіряю помилки',
    'Skill': 'Навичка',
    'Question:': 'Питання:',
    'Agent:': 'Помічник:',
    'Finish task': 'Завершити завдання',
    'Denied': 'Відхилено',
    'No result': 'Без результату',
    'Show less': 'Згорнути',
    'Looked through the project': 'Переглянув проєкт',
    'Ran a command': 'Виконав команду',
    'Used a helper': 'Залучив помічника',
    '1 retry': '1 повтор',
    'Done in': 'Готово за',
    'Checked': 'Перевірено',
    'Checked by the reviewer': 'Перевірено рецензентом',
    'Problems left': 'Лишилися проблеми',
    'Undo changes': 'Скасувати зміни',
    'Retry': 'Повторити',
    'Ask the model again': 'Запитати модель ще раз',
    'Copied': 'Скопійовано',
    'Pasted': 'Вставлено',
    'File:': 'Файл:',
    'Writing code': 'Пишу код',
    'the AI is working': 'ШІ працює',
    'No model selected': 'Модель не вибрано',
    'Click again to delete': 'Натисніть ще раз, щоб видалити',
    'Explain how closures work in JavaScript': 'Поясни, як працюють замикання в JavaScript',
    'Write a function that debounces another function': 'Напиши функцію debounce для іншої функції',
    'Make a to-do list: index.html, style.css, script.js': 'Зроби список справ: index.html, style.css, script.js',
    'Make a simple landing page for a coffee shop': 'Зроби просту сторінку для кав\'ярні',
    'Make a calculator: index.html, style.css, script.js': 'Зроби калькулятор: index.html, style.css, script.js',
    'Explain the structure of this project': 'Поясни структуру цього проєкту',
    'Find possible bugs in the main files': 'Знайди можливі помилки в основних файлах',
    'Suggest one improvement and make it': 'Запропонуй одне покращення і зроби його',
    'Open a folder in VS Code and I can read, edit and run things in your project. For now I can only chat.': 'Відкрийте теку у VS Code, і я зможу читати, змінювати й запускати ваш проєкт. Поки що я можу лише спілкуватися.',
    'Open a project folder so the AI can read and edit your files': 'Відкрийте теку проєкту, щоб ШІ міг читати й змінювати ваші файли',
    'Project access is off, so the AI can only chat. Click to turn it on and let it create and edit files in this folder.': 'Доступ до проєкту вимкнено, тож ШІ може лише спілкуватися. Натисніть, щоб увімкнути й дозволити створювати та змінювати файли в цій теці.',
    'The AI can read and edit files in this folder (it asks before changes). Click to turn off.': 'ШІ може читати й змінювати файли в цій теці (питає перед змінами). Натисніть, щоб вимкнути.',
    'This folder is not trusted (Restricted Mode), so the AI can only chat and cannot read, edit or run anything here. Click to manage workspace trust.': 'Ця тека не довірена (обмежений режим), тож ШІ може лише спілкуватися. Натисніть, щоб керувати довірою.',
    'This model cannot use tools. It still saves code into files in this folder instead of pasting it in the chat, but it cannot read your project on its own. Click to turn access off.': 'Ця модель не вміє користуватися інструментами. Вона зберігає код у файли цієї теки, але сама не читає проєкт. Натисніть, щоб вимкнути доступ.',
    'This model cannot use tools. Pick a model tagged "tools" to work with your project.': 'Ця модель не вміє користуватися інструментами. Для роботи з проєктом виберіть модель, що вміє змінювати файли.',
    'Requests per minute': 'Запитів за хвилину',
    'Requests per day': 'Запитів за день',
    'Tokens per minute': 'Токенів за хвилину',
    'Tokens per day': 'Токенів за день',
    'Limits appear after the first answer. Some providers (for example Google Gemini) never send them: check the provider page.': 'Ліміти з\'являться після першої відповіді. Деякі провайдери (наприклад, Google Gemini) їх не надсилають: дивіться сторінку провайдера.',
    'Official numbers for your account': 'Офіційні дані для вашого акаунта',
    'Last answer asked to wait': 'Остання відповідь попросила зачекати',
    'The limit was reached': 'Ліміт вичерпано',
    'after the last model answer': 'після останньої відповіді моделі',
    'did not report limits yet': 'ще не повідомив ліміти',
    'free-tier limit reported by': 'безкоштовний ліміт за даними',
    'resets in': 'скидається через',
    'Total:': 'Разом:',
    'tokens in this chat': 'токенів у цьому чаті',
    'Main agent': 'Основний агент',
    'No helper agents in this chat yet': 'У цьому чаті ще не було помічників',
    'The model starts them for bigger jobs. Ask it to use helper agents to try.': 'Модель залучає їх для великих завдань. Попросіть її використати помічників, щоб спробувати.',
    'Stop and transcribe': 'Зупинити й розпізнати',
    'Did not catch any speech. Try again a bit closer to the microphone.': 'Не вдалося розчути мову. Спробуйте ближче до мікрофона.',
    'Picture for the vision model': 'Зображення для моделі, що бачить картинки',
    'This cloud model is text-only (try Llama 4 Scout or Gemini)': 'Ця хмарна модель працює лише з текстом (спробуйте Llama 4 Scout або Gemini)',
    'Needs a vision model (e.g. gemma3)': 'Потрібна модель, що бачить картинки (наприклад, gemma3)',
    'No skills found': 'Навичок не знайдено',
    'Put skills in ~/.claude/skills or .claude/skills': 'Покладіть навички в ~/.claude/skills або .claude/skills',
    'Works on its own until the task is done. Edits and safe commands run without asking': 'Працює сам до завершення завдання. Зміни й безпечні команди виконуються без питань',
    'Every edit and command needs your approval': 'Кожна зміна й команда потребує вашого дозволу',
    'Edits are applied right away, commands still ask': 'Зміни застосовуються одразу, про команди питає',
    'The AI can look at files but changes nothing': 'ШІ може переглядати файли, але нічого не змінює',
    'Settings': 'Налаштування',
    'Advanced': 'Додатково',
    'On this computer': 'На цьому комп\'ютері',
    'chat only': 'лише чат',
    'chat & small edits': 'чат і дрібні правки',
    'simple tasks': 'прості завдання',
    'good for projects': 'для проєктів',
    'sees images': 'бачить картинки',
    'This model cannot call tools: it can only write code into files, not read or search your project.': 'Ця модель не викликає інструменти: вона може лише записувати код у файли, а не читати чи шукати по проєкту.',
    'Very small: fine for chatting and tiny edits, unreliable for project work.': 'Дуже мала: годиться для розмови й дрібних правок, ненадійна для роботи з проєктом.',
    'Small model: ok for simple tasks and short files, may claim to edit without doing it.': 'Мала модель: годиться для простих завдань і коротких файлів, може сказати, що змінила, коли насправді ні.',
    'Large enough to work on a project reliably.': 'Достатньо велика, щоб надійно працювати з проєктом.',
    'Runs comfortably on your computer': 'Комфортно працює на вашому комп\'ютері',
    'Fits your computer well': 'Добре підходить вашому комп\'ютеру',
    'Fits, but little memory is left': 'Влазить, але пам\'яті лишається мало',
    'Will partly run on the CPU and be slow': 'Частково працюватиме на процесорі й буде повільною',
    'Too heavy for this computer': 'Заважка для цього комп\'ютера',
    'The strongest model of this kind that runs well on your computer': 'Найсильніша модель цього типу, що добре працює на вашому комп\'ютері',
    'Other quantizations of this model': 'Інші варіанти стиснення цієї моделі',
    'Choose quantization (size vs quality)': 'Вибрати стиснення (розмір проти якості)',
    'Delete model': 'Видалити модель',
    'Stop downloading': 'Зупинити завантаження',
    'Starting Ollama...': 'Запускаю Ollama...',
    'Checking Ollama...': 'Перевіряю Ollama...',
    'Starting download...': 'Починаю завантаження...',
    'Used for meaning search in the project, not for chatting': 'Для пошуку за змістом у проєкті, не для розмови',
    'Remove this cloud model': 'Прибрати цю хмарну модель',
    'Remove this server and its models': 'Прибрати цей сервер і його моделі',
    'Disconnect: remove the key and its models': 'Відключити: прибрати ключ і його моделі',
    'Ask the provider how much credit and quota is left': 'Запитати провайдера, скільки лишилося кредиту й квоти',
    'Can look at pictures': 'Бачить картинки',
    'This model cannot call tools.': 'Ця модель не викликає інструменти.',
    'Small or fast model: weaker at agent tasks.': 'Мала або швидка модель: слабша в агентних завданнях.',
    'Strong at code and tools.': 'Сильна в коді й інструментах.',
    'Your skills': 'Ваші навички',
    'Custom folder': 'Власна тека',
    'Loaded skills': 'Завантажені навички',
    'Found, not loaded': 'Знайдено, не завантажено',
    'Pick the skills that match each request and give them to any model directly': 'Підбирати навички під кожен запит і передавати їх будь-якій моделі напряму',
    'Re-read the skill folders now': 'Перечитати теки навичок зараз',
    'Full access': 'Повний доступ',
    'Ask first': 'Спершу питати',
    'No access': 'Без доступу',
    'Extra folder': 'Додаткова тека',
    'Inside project': 'Усередині проєкту',
    'Active file folder': 'Тека активного файлу',
    'Remove rule': 'Прибрати правило',
    'Groq (cloud)': 'Groq (хмара)',
    'Local (offline)': 'Локально (без інтернету)',
    'Needs a recorder': 'Потрібен рекордер',
    'Not installed': 'Не встановлено',
    'Speech recognition (whisper.cpp)': 'Розпізнавання мови (whisper.cpp)',
    'Speech model': 'Модель мови',
    'How should the AI run?': 'Де працюватиме ШІ?',
    'Runs on this computer. Nothing leaves it.': 'Працює на цьому комп\'ютері. Нічого не виходить назовні.',
    // Messages from the extension
    'Planning the feature first...': 'Спершу планую...',
    'The chat is getting long: summarising the earlier messages so the model keeps the important parts...': 'Чат став довгим: стискаю ранні повідомлення, щоб модель пам\'ятала головне...',
    'Could not summarise the earlier messages; the oldest ones are left out instead.': 'Не вдалося стиснути ранні повідомлення, тож найстаріші пропущено.',
    "This conversation got long - older messages were trimmed to fit the model's context window.": 'Розмова стала довгою: старші повідомлення обрізано, щоб вмістилися в пам\'ять моделі.',
    'The model started repeating itself, so the answer was cut. This model is too weak for this task: pick a stronger one.': 'Модель почала повторюватися, тож відповідь обірвано. Ця модель заслабка для такого завдання: виберіть сильнішу.',
    "The answer reached the model's output limit and was cut off.": 'Відповідь досягла ліміту довжини моделі й обірвалася.',
    'Autopilot stopped: the model keeps replying without finishing the task.': 'Автопілот зупинено: модель відповідає, але не завершує завдання.',
    'Autopilot stopped: the model is stuck repeating the same action.': 'Автопілот зупинено: модель застрягла, повторюючи ту саму дію.',
    'Project access is on. I can now create and edit files in your project.': 'Доступ до проєкту ввімкнено. Тепер я можу створювати й змінювати файли.',
    'Cloud model not used. Pick a local model, or accept the notice to use the cloud one.': 'Хмарну модель не використано. Виберіть локальну або погодьтеся з попередженням.',
    'Pick a model in the Local Full AI sidebar first.': 'Спершу виберіть модель у бічній панелі Local Full AI.',
    'The model did not edit the files by itself, so I am asking it to write the full files directly...': 'Модель не змінила файли сама, тож прошу її написати файли повністю...',
    'No file was changed in this reply: the model only described the change. Ask again, or switch to a stronger model.': 'У цій відповіді жоден файл не змінено: модель лише описала зміну. Запитайте ще раз або виберіть сильнішу модель.',
    'Write the code by this plan?': 'Писати код за цим планом?',
    'Yes, write it': 'Так, пиши',
    'Project access is off, so I can only answer in the chat and cannot create or change files. Turn it on?': 'Доступ до проєкту вимкнено, тож я можу лише відповідати в чаті. Увімкнути?',
    'Yes, turn on project access': 'Так, увімкнути доступ',
    'No, only chat': 'Ні, лише чат',
    "Could not reach Ollama - the server isn't running.": 'Не вдалося з\'єднатися з Ollama: сервер не запущено.',
    'It takes effect from your next message.': 'Діятиме з вашого наступного повідомлення.',
    'Back to a local model: nothing leaves your computer.': 'Знову локальна модель: нічого не виходить назовні.',
    'This model cannot use tools: it saves code into your project files but cannot read them on its own.': 'Ця модель не вміє користуватися інструментами: зберігає код у файли проєкту, але сама їх не читає.'
  });

  // Messages with values in them: {1}, {2}... stand for any text.
  const TEMPLATES = {
    'Writing {1} ({2} of {3})...': 'Пишу {1} ({2} з {3})...',
    'Indexing the project for meaning search: {1} of {2} files...': 'Індексую проєкт для пошуку за змістом: {1} з {2} файлів...',
    'Model error ({1}). Retrying {2}/{3}...': 'Помилка моделі ({1}). Повторюю {2}/{3}...',
    'Autopilot: continuing the task ({1}/{2})...': 'Автопілот: продовжую завдання ({1}/{2})...',
    '{1} is reading the request...': '{1} читає запит...',
    'Loading {1} into memory. The first answer after a switch takes longer...': 'Завантажую {1} у пам\'ять. Перша відповідь після перемикання триває довше...',
    '{1} has thought long enough, so it writes the answer now...': '{1} достатньо подумала, пише відповідь...',
    '{1} started thinking in circles, so it writes the answer now...': '{1} почала думати по колу, тож пише відповідь...',
    '{1}: the per-minute token budget is almost used. Waiting {2}s so the request is not rejected...': '{1}: хвилинний ліміт токенів майже вичерпано. Чекаю {2} с, щоб запит не відхилили...',
    '{1} is busy right now (error {2}). Trying again in {3}s ({4}/4)...': '{1} зараз перевантажений (помилка {2}). Повторю через {3} с ({4}/4)...',
    '{1} free per-minute limit reached. Waiting {2}s and trying again ({3}/{4})...': '{1}: безкоштовний хвилинний ліміт вичерпано. Чекаю {2} с і повторюю ({3}/{4})...',
    'Stopped after {1} steps. Send a message to let me continue.': 'Зупинився після {1} кроків. Надішліть повідомлення, щоб я продовжив.',
    '{1} cannot use tools, so it can\'t read or edit your project. Pick a model tagged "tools" for that.': '{1} не вміє користуватися інструментами, тож не може читати чи змінювати проєкт. Виберіть модель, що вміє змінювати файли.',
    '{1} is a very small model: it often invents files or says it changed something when it did not. For work on your project pick a 7B+ model (or a cloud model) and check the changes it makes.': '{1} — дуже мала модель: часто вигадує файли або каже, що змінила щось, коли ні. Для роботи з проєктом виберіть модель від 7B (або хмарну) і перевіряйте її зміни.',
    'The checks still report problems after {1} fixes. Please look at them:\n{2}': 'Після {1} виправлень перевірки досі знаходять проблеми. Погляньте, будь ласка:\n{2}',
    'The fix made things worse ({1}), so it was undone. The files are as they were before the fix.': 'Виправлення зробило гірше ({1}), тож його скасовано. Файли такі, як були до виправлення.',
    '{1} is at its limit, so this answer continues with {2} ({3}).': '{1} вичерпала ліміт, тож цю відповідь продовжує {2} ({3}).',
    'The helper model {1} is not installed, so helpers use {2}.': 'Модель помічників {1} не встановлено, тож помічники використовують {2}.',
    'Model changed: {1} → {2}.': 'Модель змінено: {1} → {2}.',
    'Model removed (was {1}). Pick a model to continue.': 'Модель прибрано (була {1}). Виберіть модель, щоб продовжити.',
    'Local server {1}: nothing leaves your computer.': 'Локальний сервер {1}: нічого не виходить назовні.',
    'Cloud model: your messages and the files it reads are sent to {1}.': 'Хмарна модель: ваші повідомлення й файли, які вона читає, надсилаються до {1}.',
    'Undone: {1} files restored to how they were before the request.': 'Скасовано: {1} файл(и) повернуто до стану перед запитом.',
    'Undone: 1 file restored to how they were before the request.': 'Скасовано: 1 файл повернуто до стану перед запитом.',
    'Could not undo everything: {1}': 'Не вдалося скасувати все: {1}',
    'Could not restore everything: {1}': 'Не вдалося повернути все: {1}',
    'Error: {1}': 'Помилка: {1}',
    'Could not read the file "{1}": {2}': 'Не вдалося прочитати файл «{1}»: {2}',
    'Ran {1} commands': 'Виконав команд: {1}',
    'Used {1} helpers': 'Залучив помічників: {1}',
    'Done {1} steps': 'Виконано кроків: {1}',
    'Done 1 step': 'Виконано 1 крок',
    '{1} retries': 'повторів: {1}',
    '{1} files': 'файлів: {1}',
    '({1} new)': '({1} нових)',
    '{1} s': '{1} с',
    '{1} min': '{1} хв',
    'Click to see the {1} steps': 'Натисніть, щоб побачити кроки ({1})',
    '1 file changed': '1 файл змінено',
    'Searching for "{1}"': 'Шукаю «{1}»',
    'Checking problems in {1}': 'Перевіряю помилки в {1}',
    'Reading {1}': 'Читаю {1}',
    '{1}: {2} - click to change the model': '{1}: {2} — натисніть, щоб змінити модель',
    '{1} - click to change the model': '{1} — натисніть, щоб змінити модель',
    'Ask before edits: Every edit and command needs your approval. Click to change.': 'Питати перед змінами: кожна зміна й команда потребує вашого дозволу. Натисніть, щоб змінити.',
    'Edit automatically: Edits are applied right away, commands still ask. Click to change.': 'Змінювати автоматично: зміни застосовуються одразу, про команди питає. Натисніть, щоб змінити.',
    'Read only: The AI can look at files but changes nothing. Click to change.': 'Лише читання: ШІ переглядає файли, але нічого не змінює. Натисніть, щоб змінити.',
    'Autopilot: Works on its own until the task is done. Edits and safe commands run without asking. Click to change.': 'Автопілот: працює сам до завершення завдання. Натисніть, щоб змінити.',
    '+{1} new': '+{1} нових',
    'How the AI works with this model (Settings > Work mode)': 'Як ШІ працює з цією моделлю (Налаштування > Режим роботи)',
    'Editing {1}': 'Змінюю {1}',
    'Creating {1}': 'Створюю {1}',
    'Updating {1}': 'Оновлюю {1}',
    'Running {1}': 'Виконую {1}',
    'Listing {1}': 'Переглядаю {1}',
    'Drawing {1}': 'Малюю {1}',
    'Reading {1}': 'Читаю {1}',
    '1-{1} or Enter  \u00b7  Esc': '1-{1} або Enter  \u00b7  Esc',
    'Type an answer and press Enter  \u00b7  Esc': 'Напишіть відповідь і натисніть Enter  \u00b7  Esc',
    '{1} - access off': '{1} — доступ вимкнено',
    '{1} - read only': '{1} — лише читання',
    '{1} - ask first': '{1} — спершу питати',
    '{1} - no access': '{1} — без доступу',
    '{1} - saves to files': '{1} — зберігає у файли',
    '{1} - restricted mode': '{1} — обмежений режим',
    'Cloud \u00b7 {1}': 'Хмара \u00b7 {1}',
    'Searching "{1}"': 'Шукаю «{1}»',
    'resets in {1}': 'скидається через {1}',
    '\u00b7 resets in {1}': '\u00b7 скидається через {1}',
    'free-tier limit reported by {1}': 'безкоштовний ліміт за даними {1}',
    'Last answer asked to wait {1}': 'Остання відповідь попросила зачекати {1}',
    'Open {1} limits page': 'Відкрити сторінку лімітів {1}',
    'Updated {1}': 'Оновлено {1}',
    'Updated {1} \u00b7 asked to wait {2}': 'Оновлено {1} \u00b7 попросили зачекати {2}',
    '{1} did not report limits yet': '{1} ще не повідомив ліміти',
    'The provider allows only {1} tokens per minute for this model: too little for project work.': 'Провайдер дозволяє лише {1} токенів за хвилину для цієї моделі: замало для роботи з проєктом.',
    '{1} / {2} actions / {3} tokens (in {4}, out {5}) / {6}': '{1} / дій: {2} / токенів: {3} (вхід {4}, вихід {5}) / {6}'
  };

  function compileTemplate(en) {
    const parts = en.split(/\{(\d+)\}/);
    let src = '';
    parts.forEach((part, i) => {
      src += i % 2 ? '([\\s\\S]+?)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
    return new RegExp(`^${src}$`);
  }

  const TEMPLATE_RULES = Object.entries(TEMPLATES).map(([en, uk]) => [
    compileTemplate(en),
    (m) => uk.replace(/\{(\d+)\}/g, (all, n) => m[Number(n)])
  ]);

  // Ukrainian counts: 1 файл, 2 файли, 5 файлів.
  function ukCount(n, one, few, many) {
    const k = Math.abs(n) % 100;
    const d = k % 10;
    const word = k > 10 && k < 20 ? many : d === 1 ? one : d >= 2 && d <= 4 ? few : many;
    return n + ' ' + word;
  }
  RULES.push(
    [/^(\d+) files changed$/, (m) => ukCount(Number(m[1]), 'файл змінено', 'файли змінено', 'файлів змінено')],
    [/^(\d+) files$/, (m) => ukCount(Number(m[1]), 'файл', 'файли', 'файлів')]
  );

  const ATTRS = ['title', 'placeholder'];
  const SKIP = 'pre, code, textarea, input, .row.user .bubble, .row.assistant .bubble, [data-no-i18n]';

  function translateWhole(trimmed) {
    if (UK[trimmed] !== undefined) return UK[trimmed];
    for (const [re, fn] of RULES) {
      const m = trimmed.match(re);
      if (m) return fn(m);
    }
    for (const [re, fn] of TEMPLATE_RULES) {
      const m = trimmed.match(re);
      if (m) return fn(m);
    }
    return null;
  }

  function tr(text) {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const whole = translateWhole(trimmed);
    if (whole !== null) return text.replace(trimmed, whole);
    // The live status line: "<status> · 12s".
    const timed = trimmed.match(/^([\s\S]+?) \u00b7 (\d+)s$/);
    if (timed) {
      const label = translateWhole(timed[1]);
      if (label !== null) return text.replace(trimmed, label + ' \u00b7 ' + timed[2] + ' с');
    }
    // Messages made of several sentences are translated sentence by sentence.
    const sentences = trimmed.split(/(?<=[.!?])\s+(?=[A-Z])/);
    if (sentences.length > 1) {
      const done = sentences.map((s) => translateWhole(s));
      if (done.some((d) => d !== null)) return text.replace(trimmed, done.map((d, i) => (d === null ? sentences[i] : d)).join(' '));
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
        else if (m.type === 'attributes') {
          // Tooltips set by code after the element appeared (model, folder, mode buttons).
          const v = m.target.getAttribute(m.attributeName);
          const t = v && !(m.target.closest && m.target.closest('pre, code')) ? tr(v) : null;
          if (t !== null && t !== v) m.target.setAttribute(m.attributeName, t);
        }
      });
    } finally {
      busy = false;
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    translate(document.body);
  });
  window.i18n = { lang, translate };
})();
