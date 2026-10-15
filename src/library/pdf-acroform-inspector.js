import {
  PDFDocument,
  PDFName,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
  PDFSignature
} from 'pdf-lib';

/**
 * Finds the 1-based page index of a field's primary widget annotation.
 */
export function findFieldPage(field, pdfDoc) {
  try {
    const widgets = field.acroField.getWidgets();
    if (!widgets || widgets.length === 0) return null;
    const widget = widgets[0];
    if (!widget) return null;

    // 1. Try `/P` entry first (the page reference)
    const pRef = widget.dict.get(PDFName.of('P'));
    if (pRef && pRef.objectNumber !== undefined) {
      const pages = pdfDoc.getPages();
      for (let i = 0; i < pages.length; i++) {
        if (pages[i].ref && pages[i].ref.objectNumber === pRef.objectNumber) {
          return i + 1;
        }
      }
    }

    // 2. Fallback: Search all pages' Annots lists, resolving them correctly
    const pages = pdfDoc.getPages();
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      let annotsObj = page.node.get(PDFName.of('Annots'));
      if (annotsObj) {
        // If it is an indirect reference, lookup from context
        if (annotsObj.constructor.name === 'PDFRef' || annotsObj.objectNumber !== undefined) {
          annotsObj = pdfDoc.context.lookup(annotsObj);
        }
        if (annotsObj && typeof annotsObj.asArray === 'function') {
          const array = annotsObj.asArray();
          for (const annotRef of array) {
            const annotDict = pdfDoc.context.lookup(annotRef);
            if (annotDict === widget.dict) {
              return i + 1;
            }
          }
        }
      }
    }
  } catch {
    // fallback
  }
  return null;
}

/**
 * Extracts coordinates and dimensions of a field's primary widget.
 */
export function findFieldCoords(field) {
  try {
    const widgets = field.acroField.getWidgets();
    if (!widgets || widgets.length === 0) return null;
    const rect = widgets[0].getRectangle();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  } catch {
    return null;
  }
}

/**
 * Parses and returns detailed AcroForm field definitions from PDF bytes.
 */
export async function inspectAcroFormFields(pdfBytes) {
  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(pdfBytes);
  } catch (err) {
    const msg = err?.message || '';
    if (msg.includes('encrypted') || msg.includes('password') || msg.includes('Decrypt')) {
      throw new Error('Encrypted/password-protected PDFs are not supported. Please upload an unlocked PDF.');
    }
    throw new Error('Invalid or corrupted PDF file.');
  }

  let form;
  try {
    form = pdfDoc.getForm();
  } catch {
    return []; // No AcroForm exists or unable to read it
  }

  if (!form) return [];

  const fields = form.getFields();
  const result = [];

  for (const field of fields) {
    const name = field.getName();
    let type = 'Unknown';
    let value = '';
    const flags = {
      readOnly: false,
      required: false,
      options: []
    };

    try {
      flags.readOnly = field.isReadOnly();
      flags.required = field.isRequired();
    } catch {
      // Ignore if flag lookups throw on some malformed fields
    }

    if (field instanceof PDFTextField) {
      type = 'Text';
      try {
        value = field.getText() || '';
        flags.multiline = field.isMultiline();
        flags.password = field.isPassword();
      } catch {
        value = '';
      }
    } else if (field instanceof PDFCheckBox) {
      type = 'Checkbox';
      try {
        value = field.isChecked() ? 'Checked' : 'Unchecked';
      } catch {
        value = 'Unchecked';
      }
    } else if (field instanceof PDFRadioGroup) {
      type = 'Radio';
      try {
        value = field.getSelected() || '';
        flags.options = field.getOptions();
      } catch {
        value = '';
      }
    } else if (field instanceof PDFDropdown) {
      type = 'Dropdown';
      try {
        const selected = field.getSelected();
        value = Array.isArray(selected) ? selected.join(', ') : (selected || '');
        flags.options = field.getOptions();
        flags.multiSelect = field.isMultiSelect ? field.isMultiSelect() : false;
      } catch {
        value = '';
      }
    } else if (field instanceof PDFOptionList) {
      type = 'OptionList';
      try {
        const selected = field.getSelected();
        value = Array.isArray(selected) ? selected.join(', ') : (selected || '');
        flags.options = field.getOptions();
        flags.multiSelect = field.isMultiSelect ? field.isMultiSelect() : false;
      } catch {
        value = '';
      }
    } else if (field instanceof PDFSignature) {
      type = 'Signature';
      value = '[Signature]';
    }

    const page = findFieldPage(field, pdfDoc);
    const coords = findFieldCoords(field);

    result.push({
      name,
      type,
      value,
      page,
      coords,
      flags
    });
  }

  return result;
}
