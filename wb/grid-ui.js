import * as log from '../log.js';
import { GpuDCT, GpuFFT } from '../webfft.js';
import { GpuTransformProgram, GpuFrameBuffer } from '../webgl2.js';
import { GpuStatsProgram } from '../glsl/stats.js';

// TODO:
//
// - Better drag & drop.
// - Box resizing.
// - Versioned layouts.
// - Versioned shaders.
// - Layered/mipmap shaders, e.g. stats.

async function fetchDataURI(src) {
  log.assert(/^[\w/.]+$/.test(src), 'Bad URI: ' + src);
  let url = '/wb/data/' + src;
  log.i('Fetching', src, 'from', url);
  let res = await fetch(url);
  if (res.status == 404)
    return null;
  if (res.status != 200)
    throw new Error('HTTP ' + res.status);
  src = await res.text();
  return src;
}

function appendElement(parent, type, class_name, text_content, title_hint) {
  let el = document.createElement(type);
  if (class_name) el.className = class_name;
  if (text_content) el.textContent = text_content;
  if (title_hint) el.setAttribute('title', title_hint);
  parent?.append(el);
  return el;
}

export class GridUI {
  get activeSection() {
    return this.buttons.querySelector('.selected')?.id;
  }

  get activeBox() {
    for (let b of this.sgraph.boxes)
      if (b.selected)
        return b;
    return null;
  }

  get dragging() {
    return this._mode == 'dragging';
  }

  set mode(s) {
    this._mode = s;
    this.container.setAttribute('mode', s);
  }

  get layout_uri() {
    return this.sgraph.props.layout_uri.eval();
  }

  constructor(webgl, { layout_uri, container, controls, buttons, editor }) {
    this.container = container;
    this.controls = controls;
    this.buttons = buttons;
    this.editor = new TextEditor(editor);
    this.webgl = webgl;
    this.grid_size = 1 * parseFloat(getComputedStyle(container).fontSize); // px
    this.mode = 'dragging';
    this.scale = 1;
    this.drag_drop = null;
    this.viewport = { x: 0, y: 0 };
    this.sgraph = new ShaderGraphBox(this);

    log.i('Grid size:', this.grid_size, 'px');

    this.buttons.addEventListener('click',
      (e) => this.handleSectionClick(e));

    this.container.addEventListener('click',
      (e) => this.handleClick(e));

    for (let event of ['mousedown', 'mouseup', 'mousemove', 'mouseleave', 'mousewheel'])
      this.container.addEventListener(event, e => this.handleDragDrop(e));

    this.selectSection('btn-props');
    this.sgraph.props.name.value = 'sg_toplevel';
    this.sgraph.props.layout_uri.value = layout_uri;
    this.sgraph.updateProps();
  }

  drawTextures() {
    let ts = Date.now();
    this.webgl.clear();
    for (let b of this.sgraph.boxes)
      if (b instanceof TextureBox)
        b.drawBuffer();
    let dt = Date.now() - ts;
    if (dt > 10)
      log.v('Rendered all framebuffers in', dt, 'ms');
  }

  showEditor(uris, { active_uri, ondblclick }) {
    this.controls.innerHTML =
      '<div class="props"></div>' +
      '<div class="info"></div>';

    let buttons = {
      'Save': {
        title: 'Save to localStorage',
        onclick: () => {
          this.editor.vtext.stage();
          onupdated();
        },
      },
      'Undo': {
        title: 'Restore from localStorage',
        onclick: () => {
          this.editor.vtext.revert();
          onupdated();
        },
      },
      'Fork': {
        title: 'Create a copy with a different name',
        onclick: async () => {
          let t = this.editor.vtext;
          let uri = prompt('URI', t.uri);
          if (localStorage[uri] || sessionStorage[uri]) {
            log.e('URI already exists in the cache:', uri);
            return;
          }
          new CachedText(uri).staged = await t.fetch();
          add_prop(uri);
          select(uri);
        },
      },
      'Delete': {
        title: 'Delete from localStorage and sessionStorage',
        onclick: () => {
          let t = this.editor.vtext;
          t.cached = null;
          t.staged = null;
          this.editor.clearText();
          find(t.uri).remove();
          select(active_uri);
          log.i(t.uri, 'deleted');
        },
      },
    };

    let add_prop = uri =>
      appendElement(this.controls.querySelector('.props'), 'div', 'prop', uri)
        .setAttribute('uri', uri);

    for (let uri of uris)
      add_prop(uri);

    if (buttons) {
      for (let name in buttons) {
        let b = buttons[name];
        let div = document.createElement('div');
        div.onclick = b.onclick;
        div.className = 'button';
        div.textContent = name;
        div.setAttribute('title', b.title);
        b.div = div;
        this.controls.append(div);
      }
    }

    let find = uri =>
      this.controls.querySelector(`.prop[uri="${uri}"]`);

    let unselect = () =>
      this.controls.querySelector('.selected')
        ?.classList.remove('selected');

    let select = uri => {
      unselect();
      let prop = find(uri);
      if (prop) {
        prop.classList.add('selected');
        this.editor.initText(uri);
      } else {
        this.editor.clearText();
      }
      onupdated();
    };

    let update_tag = uri => {
      let vt = new CachedText(uri);
      let div = find(uri);
      let tag = vt.cached && vt.cached != vt.staged ? '*' : '';
      div.textContent = uri + tag;
    };

    let onupdated = () => {
      this.editor.updateText();
      update_tag(this.editor.uri);
      let vt = this.editor.vtext;
      let edited = vt.cached && vt.cached != vt.staged;
      buttons['Save'].div.classList.toggle('disabled', !edited);
      buttons['Undo'].div.classList.toggle('disabled', !edited);
    };

    this.controls.onclick = e =>
      e.target.classList.contains('prop') &&
      select(e.target.getAttribute('uri'));

    if (ondblclick) {
      this.controls.ondblclick = e =>
        e.target.classList.contains('prop') &&
        ondblclick(e.target.getAttribute('uri'));
    }

    if (active_uri) {
      find(active_uri).classList.add('active');
      select(active_uri);
    }

    for (let uri of uris)
      update_tag(uri);

    this.editor.onchange = async () => {
      onupdated();
      switch (this.activeSection) {
        case 'btn-layout':
          if (this.editor.uri == this.layout_uri) {
            log.v('Updating layout since it has been edited');
            await this.loadLayout();
          }
          break;
        case 'btn-shader':
          try {
            // GLSL syntax check.
            log.v('Creating a temp fragment shader to verify GLSL syntax');
            UserShaderBox.createShader(this.webgl, this.editor.text).destroy();
          } catch (err) {
            break;
          }
          let shaders = this.sgraph.boxes.filter(box =>
            box instanceof UserShaderBox &&
            box.shader_uri == this.editor.uri);
          for (let box of shaders)
            await box.updateShader();
          this.sgraph.saveLayout();
          break;
      }
    };
  }

  editActiveShader() {
    let uris = [];

    if (this.activeBox instanceof UserShaderBox)
      uris.push(this.activeBox.shader_uri);

    for (let box of this.sgraph.boxes) {
      if (box instanceof UserShaderBox && uris.indexOf(box.shader_uri) < 0) {
        uris.push(box.shader_uri);
      }
    }

    for (let i = 0; i < localStorage.length; i++) {
      let key = localStorage.key(i);
      if (key.endsWith('.glsl') && uris.indexOf(key) < 0)
        uris.push(key);
    }

    this.showEditor(uris, { active_uri: uris[0] });
  }

  editActiveLayout() {
    let active_uri = this.layout_uri;
    let uris = [active_uri];

    for (let i = 0; i < localStorage.length; i++) {
      let key = localStorage.key(i);
      if (key.endsWith('.wb') && uris.indexOf(key) < 0)
        uris.push(key);
    }

    this.showEditor(uris.sort(), {
      active_uri,
      ondblclick(uri) {
        location.search = '?wb=' + encodeURIComponent(uri);
      }
    });
  }

  showBoxesList() {
    let list = this.sgraph.boxTypes.map(
      ctor => ctor.name.replace(/Box$/, ''));

    this.showItemsList(list, {
      onclick: e => {
        let ctor = this.sgraph.boxTypes.find(
          ctor => ctor.name == e.target.textContent + 'Box');
        let info = this.controls.querySelector('.info');
        info.textContent = ctor.INFO || 'Add a ' + ctor.name;
      }
    });
  }

  showTexturesList() {
    let list = this.sgraph.boxes
      .filter(box => box instanceof TextureBox)
      .map(box => box.name);
    this.showItemsList(list, {
      active: this.activeBox instanceof TextureBox
        && this.activeBox.name,
      onclick: e => {
        let name = e.target.textContent;
        let box = this.sgraph.findBox(name);
        log.assert(box);
        box.drawBuffer(true);
      }
    });
  }

  showItemsList(list, { active, onclick }) {
    this.controls.innerHTML = list.map(
      s => `<div class="prop" tag="${s}">${s}</div>`).join('');
    this.controls.innerHTML +=
      '<div class="info"></div>';

    let btn_add = appendElement(this.controls, 'div', 'button', 'Add');
    btn_add.onclick = () => this.handleAddBox();

    this.controls.onclick = e => {
      if (!e.target.classList.contains('prop'))
        return;
      this.controls.querySelector('.selected')
        ?.classList.remove('selected');
      e.target.classList.add('selected');
      onclick(e);
    };

    if (active) {
      let prop = this.controls.querySelector(`.prop[tag="${active}"]`);
      log.assert(prop, 'No such active prop: ' + active);
      prop.classList.add('selected');
      onclick({ target: prop });
    }
  }

  async handleAddBox() {
    let target = this.controls.querySelector('.selected');
    if (this.activeSection != 'btn-boxes' || !target) return;
    let box_name = target.textContent + 'Box';
    await this.sgraph.addBox(box_name);
  }

  deleteBox(name) {
    this.sgraph.deleteBox(name);
    this.controls.textContent = '';
  }

  handleSectionClick(e) {
    if (e.target.parentElement == this.buttons)
      this.selectSection(e.target.id);
  }

  selectSection(button_id) {
    this.buttons.querySelector('.selected')
      ?.classList.remove('selected');
    let button = this.buttons.querySelector('#' + button_id);
    button.classList.add('selected');
    let mode = button.getAttribute('mode');
    this.container.parentElement.setAttribute('mode', mode);
    this.editor.clearText();
    this.controls.textContent = '';
    this.controls.onclick = null;
    this.controls.ondblclick = null;

    switch (button_id) {
      case 'btn-props':
        this.drawTextures();
        break;
      case 'btn-layout':
        this.editActiveLayout();
        break;
      case 'btn-shader':
        this.editActiveShader();
        break;
      case 'btn-boxes':
        this.showBoxesList();
        break;
      case 'btn-canvas':
        this.showTexturesList();
        break;
    }
  }

  findParentBox(e) {
    let target = e.target;
    while (target && target != this.container && !target.classList.contains('box'))
      target = target.parentElement;

    log.assert(target);
    let box = null;

    if (target.classList.contains('box')) {
      box = this.sgraph.findBox(b => b.element == target);
      log.assert(box);
    }

    return box;
  }

  handleClick(e) {
    if (this.activeSection == 'btn-canvas')
      return;
    let box = e.target == this.container ?
      this.sgraph : this.findParentBox(e);
    if (box) {
      if (box == this.sgraph && this.activeBox)
        this.activeBox.selected = false;
      // this.selectSection('btn-props');
      this.showBoxInfo(box);
    }
  }

  showBoxInfo(box) {
    if (this.activeSection != 'btn-props')
      return;
    let list = this.controls;
    list.innerHTML = '';

    // let div_header = document.createElement('div');
    // div_header.className = 'header';
    // div_header.textContent = this.name;
    // list.append(div_header);

    for (let prop_name in box.props) {
      if (/^[xywh]$/.test(prop_name))
        continue;
      let prop = box.props[prop_name];
      let div_prop = document.createElement('div');
      let div_name = document.createElement('div');
      let div_group = document.createElement('div');
      let div_value = document.createElement('div');
      let div_result = document.createElement('div');
      div_prop.className = 'prop';
      div_name.className = 'name';
      div_name.textContent = prop_name;
      div_value.className = 'value';
      div_result.className = 'result';
      div_group.className = 'val-res';

      div_value.textContent = prop.value; // expr
      div_value.contentEditable = true;
      div_value.onblur = e => this.handleBoxPropBlur(e, box);

      let res = prop.eval();
      if (res instanceof Box)
        res = res.name;
      if (res != prop.value)
        div_result.textContent = '=' + res;

      div_prop.append(div_name, div_group);
      div_group.append(div_value, div_result);
      list.append(div_prop);
    }

    let div_info = appendElement(list, 'div', 'info');

    if (box instanceof ShaderBox) {
      let btn_exec = appendElement(list, 'div', 'button', 'Execute',
        'Run the shader and draw its output texture');
      btn_exec.onclick = () => box.execShader(true);
    }

    if (box instanceof UserShaderBox) {
      let textarea = appendElement(div_info, 'textarea');
      let texteditor = new TextEditor(textarea);
      textarea.setAttribute('spellcheck', false);
      texteditor.initText(box.shader_uri);
      texteditor.onchange = async () => {
        await box.updateShader();
        this.showBoxInfo(box);
      };
    }

    if (box instanceof TextureBox) {
      let btn_update = appendElement(list, 'div', 'button', 'Redraw',
        'Run all shaders required to update this texture');
      btn_update.onclick = async () => {
        let seq = box.parent.getShadersChain(box).reverse();
        log.v('Shaders sequence to update', box.name, ':', seq.map(b => b.name).join(' '));
        for (let shader of seq)
          await shader.execShader();
      };
    }

    let btn_delete = appendElement(list, 'div', 'button', 'Delete',
      'Delete the box');
    btn_delete.onclick = () => {
      box.parent.deleteBox(box.name);
      list.textContent = '';
    };
  }

  async handleBoxPropBlur(e, box) {
    log.assert(e.target.className == 'value');
    let div_prop = e.target.parentElement.parentElement;
    let div_value = e.target;
    let div_name = div_prop.querySelector('.name');
    let prop_name = div_name.textContent;
    let str_value = div_value.textContent;
    let prop = box.props[prop_name];
    log.assert(prop);

    if (str_value == prop.value)
      return;

    prop.value = str_value;
    await box.updateProps();
    this.handleLayoutUpdated();
  }

  handleDragDrop(e) {
    if (!this.dragging)
      return;

    e.preventDefault();

    let gs = this.grid_size;
    let mx = e.clientX / this.scale;
    let my = e.clientY / this.scale;
    let dx = mx - this.drag_drop?.mx;
    let dy = my - this.drag_drop?.my;
    let box = this.drag_drop?.box;

    switch (e.type) {
      case 'mousedown':
        box = this.findParentBox(e);
        // log.v('Moving', box ? box.name : 'container');

        this.drag_drop = {
          box: box,
          moved: false,
          resize: e.target.classList.contains('resize'),
          mx: mx,
          my: my,
          vx: this.viewport.x,
          vy: this.viewport.y,
        };

        if (box) {
          box.selected = true;
          this.drag_drop.cx = +box.element.style.left.replace('px', '');
          this.drag_drop.cy = +box.element.style.top.replace('px', '');
          this.drag_drop.cw = +box.element.style.width.replace('px', '');
          this.drag_drop.ch = +box.element.style.height.replace('px', '');
          this.drag_drop.sx = +box.props.x.value;
          this.drag_drop.sy = +box.props.y.value;
        }
        break;
      case 'mousemove':
        if (this.drag_drop) {
          if (box) {
            if (dx || dy) {
              if (this.drag_drop.resize) {
                box.element.style.width = (this.drag_drop.cw + dx) + 'px';
                box.element.style.height = (this.drag_drop.ch + dy) + 'px';
              } else {
                box.element.style.left = (this.drag_drop.cx + dx) + 'px';
                box.element.style.top = (this.drag_drop.cy + dy) + 'px';
              }
              this.drag_drop.moved = true;
            }
          } else {
            this.viewport.x = this.drag_drop.vx + (this.scale * dx / gs | 0) * gs;
            this.viewport.y = this.drag_drop.vy + (this.scale * dy / gs | 0) * gs;
            this.updateViewportTransform();
          }
        }
        break;
      case 'mousewheel':
        if (this.activeSection == 'btn-props' || this.activeSection == 'btn-canvas') {
          this.scale *= 0.9 ** Math.sign(e.deltaY);
          this.updateViewportTransform();
        }
        break;
      case 'mouseup':
        if (box) {
          if (this.drag_drop.moved) {
            if (this.drag_drop.resize) {
              let w = +box.props.w.value + Math.round(dx / gs);
              let h = +box.props.h.value + Math.round(dy / gs);
              box.props.w.value = Math.max(2, w);
              box.props.h.value = Math.max(2, h);
            } else {
              let x = +box.props.x.value + Math.round(dx / gs);
              let y = +box.props.y.value + Math.round(dy / gs);
              box.props.x.value = x;
              box.props.y.value = y;
            }
            box.updateProps();
            this.handleLayoutUpdated();
          }
        }
      case 'mouseleave':
        if (this.drag_drop) {
          this.drag_drop = null;
          // log.v('Stopped dragging due to', e.type);
        }
        break;
    }
  }

  updateViewportTransform() {
    this.container.style.transform = 'translate(' +
      this.viewport.x + 'px,' + this.viewport.y + 'px) ' +
      'scale(' + this.scale.toFixed(4) + ')';
    this.webgl.canvas.style.transform =
      this.container.style.transform;
  }

  handleLayoutUpdated() {
    this.drawTextures();
    this.sgraph.saveLayout();
  }

  async loadLayout() {
    if (await this.sgraph.loadLayout())
      this.drawTextures();
  }
}

class Box {
  static count = 0;

  constructor(parent) {
    this.id = ++Box.count;
    this.parent = parent;
    this.scope = parent;
    this.grid_ui = parent instanceof GridUI ? parent : parent.grid_ui;
    this.element = document.createElement('div');
    this.element.className = 'box';
    this.title = document.createElement('div');
    this.title.className = 'title';
    this.content = document.createElement('div');
    this.content.className = 'content';
    this.resize_tag = document.createElement('div');
    this.resize_tag.className = 'resize';
    this.element.append(this.title, this.content, this.resize_tag);
    this.props = {};

    this.props.name = this.createProp('box_' + this.id, new StrType(/^[\w-._]+$/));
    this.props.w = this.createProp(10, new IntType(1));
    this.props.h = this.createProp(10, new IntType(1));
    this.props.x = this.createProp(0, new IntType());
    this.props.y = this.createProp(0, new IntType());
  }

  get name() {
    return this.props.name.value;
  }

  get selected() {
    return this.element.classList.contains('selected');
  }

  set selected(x) {
    if (x) {
      let el = this.grid_ui.container.querySelector('.selected');
      el && el.classList.remove('selected');
      this.element.classList.add('selected');
    } else {
      this.element.classList.remove('selected');
    }
  }

  destroy() {
    this.element.remove();
  }

  createProp(value, type) {
    return new Prop(value, type,
      (s, t) => this.evalProp(s, t));
  }

  evalProp(str, type) {
    log.assert(str !== '');

    if (typeof str == 'string') {
      if (this.parent instanceof ShaderGraphBox) {
        let arg = this.parent.vars[str];
        if (arg) return arg.eval();

        let tex = this.parent.findBox(str);
        if (tex) return tex;
      }

      if (this instanceof ShaderGraphBox) {
        let tex = this.findBox(str);
        if (tex) return tex;
      }
    }

    return type.parse(str);
  }

  updateProps() {
    this.title.textContent = this.name;

    let x = +this.props.x.value;
    let y = +this.props.y.value;
    let w = +this.props.w.value;
    let h = +this.props.h.value;

    this.props.x.value = x;
    this.props.y.value = y;
    this.props.w.value = w;
    this.props.h.value = h;

    let gs = this.grid_ui.grid_size;

    this.element.style.left = x * gs + 'px';
    this.element.style.top = y * gs + 'px';
    this.element.style.width = w * gs + 'px';
    this.element.style.height = h * gs + 'px';

    this._x = x;
    this._y = y;
    this._w = w;
    this._h = h;
  }
}

class ShaderBox extends Box {
  get webgl() {
    return this.parent.webgl;
  }

  constructor(parent) {
    super(parent);
    this.element.classList.add('shader');
    this.props.output = this.createProp('tex_0', new TexNameType());
    this.props.name.value = 'shader_' + this.id;
  }

  async updateProps() {
    await super.updateProps();
    this.title.textContent = this.name +
      ' -> ' + this.props.output.value;
  }

  async execShader(user_click = false) {
    let output = this.props.output.eval();
    log.assert(output instanceof TextureBox, 'No output texture in ' + this.name);
    log.assert(output.fb, output.name + ' doesnt have a framebuffer attached');
    await this.execShaderInternal(output.fb, user_click);
    output.drawBuffer();
  }

  async execShaderInternal(output_fb, user_click) { }
}

class UserShaderBox extends ShaderBox {
  static INFO = 'Creates a custom GLSL shader.';

  static createShader(webgl, fs_src) {
    log.assert(webgl);
    return new GpuTransformProgram(webgl, {
      fshader: `
        in vec2 vTex;
        uniform int uOutputWidth;
        uniform int uOutputHeight;
        uniform int uOutputChannels;
        ${fs_src}
        void main () {
          v_FragColor = eval();
        }
      `,
    })
  }

  constructor(parent) {
    super(parent);

    this.fs = null;
    this.fs_src = '';
    this.fs_url = '';
    this.uniforms = {};

    this.props.shader_uri = this.createProp(
      this.name + '.glsl', new StrType(/.+\.glsl$/));
  }

  get shader_uri() {
    return this.props.shader_uri.value;
  }

  destroy() {
    super.destroy();
    this.fs?.destroy();
  }

  async updateProps() {
    await super.updateProps();
    let fs_url = this.shader_uri;
    if (this.fs_url != fs_url || !fs_url)
      await this.updateShader();
  }

  async updateShader() {
    let fs_src = null;
    let fs_url = this.shader_uri;
    let regex = /^\s*uniform (\w+) (u[A-Z]\w*);\s*$/;
    let vt = new CachedText(fs_url);
    fs_src = await vt.fetch();

    if (this.fs_src == fs_src)
      return;

    if (!fs_src) {
      let stub = new CachedText('stub.glsl');
      fs_src = await stub.fetch();
      log.assert(fs_src);
      vt.staged = fs_src;
    }

    log.i('Updating shader', this.name, '->', fs_url);
    log.v(fs_src);

    if (!vt.staged)
      vt.staged = fs_src;

    for (let name in this.uniforms)
      delete this.props[name];
    this.uniforms = {};

    for (let line of fs_src.split('\n')) {
      if (!/\s*uniform\s/.test(line))
        continue;
      let match = regex.exec(line);
      if (!match) {
        log.e(line, 'doesnt match', regex);
        continue;
      }
      let [, type, name] = match;
      if (this.props[name]) {
        log.e(line, 'overrides a same-named prop');
        continue;
      }
      log.v('Creating a prop from uniform', type, name);

      let prop_type = type == 'sampler2D' ? new TexNameType() :
        type == 'float' ? new FloatType() :
          type == 'int' ? new IntType() :
            null;

      if (!prop_type) {
        log.e('Unsupported uniform', type, name);
        continue;
      }

      this.props[name] = this.createProp('0', prop_type);
      this.uniforms[name] = true;
    }

    this.fs = UserShaderBox.createShader(this.webgl, fs_src);
    this.fs_src = fs_src;
    this.fs_url = fs_url;
    this.content.textContent = fs_src;
  }

  getUniformValue(name) {
    let prop = this.props[name];
    let pval = prop.eval();

    if (prop.type instanceof TexNameType) {
      log.assert(pval instanceof TextureBox && pval.fb,
        this.name + '.' + name + ' must be a framebuffer');
      pval = pval.fb;
    }

    return pval;
  }

  execShaderInternal(output_fb) {
    let bindings = {
      uOutputWidth: output_fb.width,
      uOutputHeight: output_fb.height,
      uOutputChannels: output_fb.channels,
    };
    for (let name in this.props)
      if (/u[A-Z]\w*/.test(name))
        bindings[name] = this.getUniformValue(name);
    let ts = Date.now();
    this.fs.exec(bindings, output_fb);
    log.i(this.name, 'has updated', this.props.output.value,
      'in', Date.now() - ts, 'ms');
  }
}

class ShaderGraphBox extends ShaderBox {
  static INFO = 'Creates a new graph of shaders and textures. It can use other shader graphs.';

  constructor(parent) {
    super(parent);

    this.embedded = parent instanceof ShaderGraphBox;
    this.scope = this.embedded ? parent : this;
    this.boxes = [];
    this.vars = {};
    this.outs = [];
    this.box_ctors = {};
    this.layout = null;

    this.boxTypes = [
      TextureBox,
      UserShaderBox,
      AudioFileBox,
      ImageFileBox,
      DFTShaderBox,
      StatsShaderBox,
      ShaderGraphBox,
    ];

    for (let ctor of this.boxTypes)
      this.box_ctors[ctor.name] = ctor;

    this.props.name.value = 'sgraph_' + this.id;
    this.props.layout_uri = this.createProp('stub.sg', new StrType(/.+\.(sg|wb)$/));
  }

  destroy() {
    super.destroy();
    for (let b of this.boxes)
      b.destroy();
    this.boxes = [];
  }

  async execShader(user_click = false) {
    log.i('Executing shader graph:', this.name);
    let target = this.props.output.eval();
    log.assert(target instanceof TextureBox, 'No output texture');
    let shaders = this.getShadersChain(target).reverse();
    log.assert(shaders.indexOf(this) < 0);
    log.v('Running shaders:', shaders.map(b => b.name).join(', '));
    for (let box of shaders)
      await box.execShader(user_click);
    target.drawBuffer();
  }

  async updateProps() {
    await super.updateProps();

    let uri = this.props.layout_uri.value;
    if (uri == this.layout?.uri)
      return;

    for (let p in this.props)
      if (/^[A-Z]/.test(p))
        delete this.props[p];

    if (!uri) return;
    log.i(this.name, 'is changing layout:',
      this.layout?.uri || null, '->', uri);

    this.layout = new CachedText(uri);

    if (!await this.loadLayout())
      throw new Error('Failed to load ' + uri);

    for (let name in this.vars)
      this.props[name] = this.vars[name];

    if (this.outs.length > 0) {
      if (this.outs.length > 1)
        log.w(this.name, 'Too many OUT args:', this.outs.join(' '));
      this.props.output = this.vars[this.outs[0]];
    } else {
      log.w(this.name, 'No OUT args declared');
    }

    this.content.textContent = uri + ', ' + this.boxes.length + ' boxes';
  }

  findBox(name) {
    log.assert(name);
    if (typeof name == 'string') {
      for (let b of this.boxes)
        if (b.name == name)
          return b;
    } else if (typeof name == 'function') {
      for (let b of this.boxes)
        if (name(b))
          return b;
    }
    return null;
  }

  async addBox(type_name) {
    let ctor = this.boxTypes.find(ctor => ctor.name == type_name);
    log.assert(ctor, type_name + ' not registered');
    let box = new ctor(this);
    while (this.findBox(box.name)) {
      box.id++;
      let p = box.props.name;
      p.value = p.value.replace(/_\d+$/, '_' + box.id);
    }
    await box.updateProps();
    this.boxes.push(box);
    if (!this.embedded)
      this.grid_ui.container.append(box.element);
    log.i(box.name, 'added');
    this.saveLayout();
    return box;
  }

  deleteBox(name) {
    log.i('Deleting', name);
    let box = this.boxes.find(b => b.name == name);
    if (!box) return;
    box.destroy();
    this.boxes.splice(this.boxes.lastIndexOf(box), 1);
    this.saveLayout();
    return box;
  }

  escapeStr(str) {
    let rx = /[^\w.-_:]/g;
    if (!rx.test(str)) return str;
    str = encodeURIComponent(str);
    str = str.replace(/[(]/g, '%28');
    return '"' + str + '"';
  }

  unescapeStr(str) {
    if (str[0] != '"') return str;
    str = str.replace(/^"|"$/g, '');
    return decodeURIComponent(str);
  }

  saveLayout() {
    let ts = Date.now();
    let var_lines = [];
    let box_lines = [];
    let shader_lines = [];
    let shaders = {};

    for (let box of this.boxes) {
      let box_name = box.props.name.value;
      let box_type = box.constructor.name.replace(/Box$/, '');
      let prop_w = p => /^[xywh]$/.test(p) ? 2 : /^(shader_uri|layout_uri)$/.test(p) ? 0 : 1;
      let prop_names = Object.keys(box.props).sort((a, b) => prop_w(a) - prop_w(b));
      let props = [];

      for (let prop_name of prop_names) {
        if (prop_name == 'name') continue;
        if (prop_name == 'output' && box instanceof ShaderGraphBox) continue;
        let prop = box.props[prop_name];
        let value = this.vars[prop_name] ?
          prop_name : Number.isFinite(prop.value) ? prop.value :
            this.escapeStr(prop.value + '');
        props.push(prop_name + '=' + value);
      }

      box_lines.push('BOX ' + box_name + ' = ' + box_type + '(' + props.join(' ') + ')');

      if (box instanceof UserShaderBox) {
        let uri = box.shader_uri;
        if (!shaders[uri]) {
          shaders[uri] = true;
          let vt = new CachedText(uri);
          if (vt.staged) {
            shader_lines.push('SHADER ' + uri + ' = '
              + this.escapeStr(vt.staged));
          }
        }
      }
    }

    for (let name in this.vars) {
      let type = this.outs.indexOf(name) < 0 ? 'ARG' : 'OUT';
      var_lines.push(type + ' ' + name + ' = ' +
        this.escapeStr(this.vars[name].value));
    }

    this.layout.cached = [
      var_lines.join('\n'),
      box_lines.join('\n'),
      shader_lines.join('\n\n'),
    ].join('\n\n');
    this.layout.stage();
    let dt = Date.now() - ts;
    log.i('Layout', this.layout.uri, 'saved in', dt, 'ms');
  }

  async loadLayout() {
    log.i('Loading layout:', this.layout.uri);
    let layout_text = (await this.layout.fetch()) || '';
    log.v(layout_text);

    if (!await this.parseLayout(layout_text))
      return false;

    if (!this.embedded) {
      for (let box of this.boxes)
        this.grid_ui.container.append(box.element);
    }

    return true;
  }

  async parseLayout(layout_text) {
    let ts = Date.now();
    let boxes = {}, vars = {}, outs = [];
    let var_regex = /^(ARG|VAR|OUT)\s+(\w+)\s*=\s*(.+)$/;
    let box_regex = /^BOX\s+(\w+)\s*=\s*(\w+)\((.+)\)$/;
    let shader_regex = /^SHADER\s+(\S+)\s*=\s*(.+)$/;

    for (let line of layout_text.split('\n')) {
      line = line.trim();
      if (!shader_regex.test(line))
        continue;
      let [, uri, str] = shader_regex.exec(line);
      str = this.unescapeStr(str);
      let vt = new CachedText(uri);
      vt.staged = str;
      log.v('Stored shader', uri);
    }

    for (let line of layout_text.split('\n')) {
      line = line.trim();
      if (!var_regex.test(line))
        continue;
      let [, type, name, str] = var_regex.exec(line);
      if (name != name.toUpperCase()) {
        log.e('ARG ' + name, 'must be upper cased');
        return false;
      }
      str = this.unescapeStr(str);
      if (vars[name])
        log.w('ARG', name, 'already declared');
      if (type == 'OUT')
        outs.push(name);
      vars[name] = this.createProp(str, new StrType());
    }

    for (let line of layout_text.split('\n')) {
      line = line.trim();
      if (!box_regex.test(line))
        continue;

      let [, box_name, box_type, props] = box_regex.exec(line);
      log.v('Creating', box_name, ':', box_type);
      let ctor = this.box_ctors[box_type + 'Box'];

      if (!ctor) {
        log.e('Unknown box type:', box_type);
        return false;
      }

      if (boxes[box_name]) {
        log.e('Box with such name already exists:', box_name);
        return false;
      }

      let box = new ctor(this, {}, this.webgl);
      let prop_weight = p => /^shader_uri|layout_uri\b/.test(p) ? 0 : 1;
      let prop_vals = props.split(/\s+/).sort(
        (a, b) => prop_weight(a) - prop_weight(b));

      box.props.name.value = box_name;

      for (let arg of prop_vals) {
        let [prop_name, str_value] = arg.split('=');
        let prop = box.props[prop_name];

        if (!prop) {
          log.w('No such property:', box_name + '.' + prop_name);
          continue;
        }

        try {
          str_value = this.unescapeStr(str_value);
        } catch (err) {
          log.e(err.message + ':', box_name + '.' + arg);
          return false;
        }

        prop.value = str_value; // expr

        try {
          if (!prop_weight(prop_name)) {
            log.i('Updating box for', box.name + '.' + prop_name);
            await box.updateProps();
          }
        } catch (err) {
          log.e(box.name, 'has invalid props:', err.message);
        }
      }

      boxes[box_name] = box;
    }

    log.v('Deleting the old layout');
    for (let b of this.boxes)
      b.destroy();

    log.v('Updating all box props');
    this.boxes = Object.values(boxes);
    this.vars = vars;
    this.outs = outs;

    for (let b of this.boxes) {
      try {
        await b.updateProps();
      } catch (err) {
        log.e(b.name, 'has invalid props:', err.message);
      }
    }

    log.i('Layout', this.layout.uri, 'with', this.boxes.length,
      'boxes', 'loaded in', Date.now() - ts, 'ms');
    return true;
  }

  // Shaders must be run in the reverse order.
  getShadersChain(box, already_seen = {}) {
    log.assert(box instanceof TextureBox);

    let shaders = this.boxes.filter(
      b => b instanceof ShaderBox && b.props.output.eval()?.name == box.name);
    // log.v(box.name, 'is updated by shaders:', shaders.map(b => b.name));

    if (shaders.length > 1) {
      log.w(box.name, 'is updated by ' + shaders.length +
        ' shaders: ' + shaders.map(b => b.name).join(', '));
      log.v(shaders[0].name, 'will be chosen');
      shaders = [shaders[0]];
    }

    if (!shaders.length) {
      log.e(box.name, 'is not updated by any shaders in', this.name);
      return [];
    }

    let sequence = [];
    let shader = shaders[0];

    if (already_seen[shader.name]) {
      return [];
    }

    already_seen[shader.name] = true;
    sequence.push(shader);
    let prop_names = Object.keys(shader.props).filter(
      name => name != 'output' && shader.props[name].type instanceof TexNameType);
    let inputs = prop_names.map(p => shader.props[p].eval());
    let seqs = inputs.map(tex => tex.parent.getShadersChain(tex, already_seen));

    for (let seq of seqs.reverse())
      sequence.push(...seq);

    return sequence;
  }
}

class TextureBox extends Box {
  static INFO = 'Creates a 2D framebuffer.';

  get webgl() {
    return this.parent.webgl;
  }

  constructor(parent, size) {
    super(parent, size);

    this.fb = null;

    this.element.classList.add('texture');
    this.element.addEventListener('click',
      () => this.drawBuffer());

    this.props.name.value = 'tex_' + this.id;
    this.props.width = this.createProp(1024, new IntType(1, 4096));
    this.props.height = this.createProp(1024, new IntType(1, 4096));
    this.props.channels = this.createProp(4, new IntType(1, 4));
  }

  destroy() {
    super.destroy();
    this.fb?.destroy();
  }

  async updateProps() {
    await super.updateProps();

    let w = this.props.width.eval();
    let h = this.props.height.eval();
    let c = this.props.channels.eval();
    let fb = this.fb;

    if (!fb || w != fb.width || h != fb.height || c != fb.channels) {
      let fb_size = { width: w, height: h, channels: c };
      this.fb?.destroy();
      this.fb = new GpuFrameBuffer(this.webgl, fb_size);
    }

    this.title.textContent = this.props.name.value +
      ' ' + w + 'x' + h + 'x' + c;
  }

  drawBuffer(fullscreen = false) {
    let cw = this.webgl.canvas.width;
    let ch = this.webgl.canvas.height;
    let pw = this.grid_ui.container.offsetWidth;
    let ph = this.grid_ui.container.offsetHeight;
    let be = this.element;
    let bt = this.title;
    let w = be.offsetWidth / pw * cw | 0;
    let h = (be.offsetHeight - bt.offsetHeight) / ph * ch | 0;
    let x = be.offsetLeft / pw * cw | 0;
    let y = (ph - be.offsetTop - be.offsetHeight) / ph * ch | 0;
    if (fullscreen)
      x = y = w = h = 0;
    this.fb.draw(x, y, w, h);
  }
}

class FileBox extends ShaderBox {
  constructor(parent, ui_size) {
    super(parent, ui_size);
    this.exts = '*/*';
  }

  async selectFile() {
    let input = document.createElement('input');
    input.type = 'file';
    input.accept = this.exts;
    input.click();

    let file = await new Promise(resolve => {
      input.onchange = () => {
        let files = input.files || [];
        resolve(files[0] || null);
      };
    });

    return file;
  }
}

// Uploads an audio buffer to a GPU texture.
class AudioFileBox extends FileBox {
  static INFO = 'Allows to select an audio file and upload it to a texture. '
    + 'RGBA components of the texture are filled sequentially with audio samples.';

  constructor(parent, ui_size) {
    super(parent, ui_size);

    this.audio_context = null;
    this.audio_buffer = null;

    this.props.sample_rate = this.createProp(48e3, new IntType(1e3, 1e5));
    this.props.channel = this.createProp(0, new IntType(0, 9));

    this.exts = 'audio/mpeg; audio/wav; audio/webm';
    this.props.name.value = 'audio_' + this.id;
  }

  destroy() {
    super.destroy();
    log.v('Deleting AudioContext');
    this.audio_context?.close();
    this.audio_buffer = null;
  }

  async execShaderInternal(output_fb, user_click) {
    if (user_click || !this.audio_buffer) {
      if (!await this.selectAudioFile())
        return;
    }

    let channel = this.props.channel.eval();
    log.v('Reading audio channel', channel);

    let audio_samples = new Float32Array(
      this.audio_buffer.getChannelData(channel));

    let fb = output_fb;
    let fb_size = fb.width * fb.height * fb.channels;
    let sample_rate = this.audio_buffer.sampleRate;

    if (audio_samples.length > fb_size)
      audio_samples = audio_samples.slice(0, fb_size);

    fb.upload(audio_samples); // Send audio data to GPU.

    let duration = audio_samples.length / sample_rate
    log.i('Uploaded', duration.toFixed(1),
      'sec of audio to', this.props.output.value,
      'with total capacity of', (fb_size / sample_rate).toFixed(1), 'sec');
  }

  async selectAudioFile() {
    let sampleRate = this.props.sample_rate.eval();
    log.v('Creating an AudioContext', sampleRate, 'Hz');

    if (this.audio_context?.sampleRate != sampleRate) {
      this.audio_context?.close();
      this.audio_buffer = null;
      this.audio_context = new AudioContext({ sampleRate });
    }

    let file = await this.selectFile();

    if (!file) {
      log.i('No file selected');
      return false;
    }

    let encoded_data = await file.arrayBuffer();
    log.i('Decoding audio data:', file.type);
    let ts = Date.now();
    this.audio_buffer = await this.audio_context.decodeAudioData(encoded_data);
    log.i('Audio decoded in', (Date.now() - ts) / 1000 | 0, 'sec');

    this.content.textContent =
      this.audio_buffer.duration.toFixed(1) + 's ' +
      this.audio_buffer.numberOfChannels + 'ch ' +
      (this.audio_buffer.sampleRate / 1e3) + 'kHz ' +
      (this.audio_buffer.length / 1e3 | 0) + 'KB ' +
      file.name;

    return true;
  }
}

// Uploads image data to a GPU texture.
class ImageFileBox extends FileBox {
  static INFO = 'Allows to select an image file and upload it to a texture. '
    + 'RGBA components of the image become RGBA components of the texture.';

  constructor(parent, ui_size) {
    super(parent, ui_size);
    this.img_data = null;
    this.exts = 'image/jpeg; image/ico; image/png';
    this.props.name.value = 'img_' + this.id;
  }

  destroy() {
    super.destroy();
  }

  async execShaderInternal(output_fb, user_click) {
    let w = output_fb.width;
    let h = output_fb.height;
    let d = output_fb.channels;

    if (user_click || !this.img_data)
      await this.updateImageData();

    if (!this.img_data)
      return;

    let fb_data = new Float32Array(w * h * d);
    let iw = this.img_data.width;
    let ih = this.img_data.height;

    for (let x = 0; x < w && x < iw; x++)
      for (let y = 0; y < h && y < ih; y++)
        for (let c = 0; c < d && c < 4; c++)
          fb_data[((h - y - 1) * w + x) * 4 + c] =
            this.img_data.data[(y * iw + x) * 4 + c] / 255;

    log.assert(fb_data.length == output_fb.capacity);
    output_fb.upload(fb_data); // Send image data to GPU.
  }

  async updateImageData() {
    let file = await this.selectFile();
    if (!file) return;

    let img = document.createElement('img');

    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = err => reject(err);
      img.src = URL.createObjectURL(file);
    });

    let canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;

    let ctx2d = canvas.getContext('2d');
    ctx2d.drawImage(img, 0, 0);

    this.img_data = ctx2d.getImageData(0, 0, img.width, img.height);
    this.content.textContent = file.name + ' ' + img.width + 'x' + img.height;
  }
}

class DFTShaderBox extends ShaderBox {
  static INFO = 'Computes complex-valued per-column DFT or DCT. This is not a 2D DFT.';

  constructor(parent, ui_size) {
    super(parent, ui_size);

    this.fft = null;

    this.props.input = this.createProp('tex_0', new TexNameType());
    this.props.layout = this.createProp('cols', new EnumType('rows', 'cols'));
    this.props.mode = this.createProp('dct', new EnumType('dct', 'dft'));
    this.props.name.value = 'dft_' + this.id;
  }

  execShaderInternal(output_fb) {
    let layout = this.props.layout.eval();
    let input = this.props.input.eval();

    log.assert(input instanceof TextureBox);
    log.assert(input.fb.width == output_fb.width &&
      input.fb.height == output_fb.height);

    let num_frames = output_fb.width;
    let fft_size = output_fb.height;
    let ctor = this.props.mode.eval() == 'dct' ? GpuDCT : GpuFFT;

    if (this.fft?.width != num_frames || this.fft?.height != fft_size
      || !(this.fft instanceof ctor)) {
      this.fft = new ctor(this.webgl,
        { width: num_frames, height: fft_size, layout })
    }

    this.fft.exec({ uInput: input.fb }, output_fb);
  }
}

class StatsShaderBox extends ShaderBox {
  static INFO = 's.x = min; s.y = max; s.z = avg; s.w = stddev; vec4 s = texture(uStats, vec2(0.0));';

  constructor(parent, ui_size) {
    super(parent, ui_size);
    this.stats = null;
    this.props.input = this.createProp('tex_0', new TexNameType());
    this.props.name.value = 'stats_' + this.id;
  }

  async updateProps() {
    await super.updateProps();

    let input = this.props.input.eval();
    let output = this.props.output.eval();

    if (output instanceof TextureBox) {
      log.assert(output.props.channels.eval() == 4 &&
        output.props.width.eval() == 1 &&
        output.props.height.eval() == 1,
        'Output must be a 1x1x4 texture');
    }

    if (input instanceof TextureBox) {
      log.assert(input.props.width.eval() == input.props.height.eval(),
        'Input must be a NxN texture');
      let size = input.props.width.eval();
      this.stats = new GpuStatsProgram(this.webgl, { size });
    }
  }

  execShaderInternal(output_fb) {
    let input = this.props.input.eval();
    log.assert(input, 'Input texture is missing');
    this.stats.exec({ uData: input.fb }, output_fb);
  }
}

class CachedText {
  constructor(uri) {
    log.assert(uri);
    this.uri = uri;
  }

  get cached() {
    return sessionStorage[this.uri];
  }

  set cached(str) {
    if (str)
      sessionStorage[this.uri] = str;
    else
      sessionStorage.removeItem(this.uri);
  }

  get staged() {
    return localStorage[this.uri];
  }

  set staged(str) {
    if (str)
      localStorage[this.uri] = str;
    else
      localStorage.removeItem(this.uri);
  }

  stage() {
    log.assert(this.cached, 'Staging an empty text?');
    this.staged = this.cached;
    this.cached = '';
  }

  revert() {
    this.cached = '';
  }

  async fetch() {
    return this.cached || this.staged || await fetchDataURI(this.uri) || '';
  }
}

class TextEditor {
  constructor(textarea) {
    this.textarea = textarea;
    this.initial_text = '';
    this.vtext = null;

    this.textarea.addEventListener('blur',
      (e) => this.handleBlur(e));
  }

  async initText(uri) {
    this.vtext = new CachedText(uri);
    await this.updateText();
  }

  async updateText() {
    let text = await this.vtext.fetch();
    this.initial_text = text.trim();
    this.textarea.value = this.initial_text;
  }

  clearText() {
    this.vtext = null;
    this.initial_text = '';
    this.textarea.value = '';
  }

  get uri() {
    return this.vtext.uri;
  }

  get text() {
    return this.textarea.value.trim();
  }

  handleBlur(e) {
    if (e.target != this.textarea)
      return;
    if (this.text == this.initial_text)
      return;
    this.vtext.cached = this.text;
    this.initial_text = this.text;
    this.onchange();
  }
}

class Prop {
  constructor(value, type, eval_fn) {
    this.value = value;
    this.type = type;
    this.eval_fn = eval_fn;
  }

  eval() {
    log.assert(this.eval_fn);
    return this.eval_fn(this.value, this.type);
  }
}

class PropType {
  check() {
    return true;
  }

  parse(str) {
    return str;
  }
}

class IntType extends PropType {
  constructor(min = -Infinity, max = Infinity) {
    super();
    log.assert(min <= max);
    this.min = min;
    this.max = max;
  }

  check(str) {
    let x = parseInt(str);
    return Number.isFinite(x) && x == Math.round(x)
      && x >= this.min && x <= this.max;
  }

  parse(str) {
    return +str;
  }
}

class FloatType extends PropType {
  constructor(min = -Infinity, max = Infinity) {
    super();
    log.assert(min <= max);
    this.min = min;
    this.max = max;
  }

  check(str) {
    let x = parseFloat(str);
    return Number.isFinite(x)
      && x >= this.min && x <= this.max;
  }

  parse(str) {
    return +str;
  }
}

class StrType extends PropType {
  constructor(regex) {
    super();
    this.regex = regex;
  }

  check(str) {
    return !this.regex || this.regex.test(str);
  }
}

class TexNameType extends StrType {
  constructor() {
    super(/^\w+$/);
  }
}

class EnumType extends PropType {
  constructor(...values) {
    super();
    log.assert(values.length > 0);
    this.values = values;
  }

  check(str) {
    return this.values.indexOf(str) >= 0;
  }
}
